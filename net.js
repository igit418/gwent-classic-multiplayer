"use strict"

/*
 * Online multiplayer for Gwent Classic.
 *
 * Both browsers run the same game simulation (lockstep). Only player decisions travel
 * over the network: which card was played to which row, carousel picks, passes, leader
 * use, etc. All randomness comes from generators seeded with a seed chosen by the host,
 * so both simulations shuffle and draw identically.
 *
 * Transport: PeerJS (WebRTC, peer-to-peer). The public PeerJS server is only used to
 * introduce the two browsers, so the game can be hosted on any static host
 * (e.g. GitHub Pages). Adding ?net=local to the URL switches to a BroadcastChannel
 * transport that connects two tabs of the same browser - useful for testing.
 * STUN/TURN servers are configured in net-config.js; ?relay forces traffic through TURN.
 *
 * All messages are written from the sender's point of view ("self" = the sender).
 */

const NET_PROTOCOL = 1;
const NET_PEER_PREFIX = "gwentclassic-online-";
const NET_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NET_CODE_LENGTH = 5;
// Same as the PeerJS defaults: Google STUN plus the free (best effort) PeerJS TURN servers
const NET_DEFAULT_ICE_SERVERS = [
	{urls: "stun:stun.l.google.com:19302"},
	{urls: ["turn:eu-0.turn.peerjs.com:3478", "turn:us-0.turn.peerjs.com:3478"], username: "peerjs", credential: "peerjsp"}
];

// Controls the opponent in an online game: waits for that player's decisions to arrive
class ControllerRemote {
	constructor(player) {
		this.player = player;
	}

	// Plays out the remote player's turn
	async startTurn(player) {
		const m = await Net.next("turn");
		switch (m.kind) {
			case "pass":
				AudioManager.playSFX("pass");
				player.passRound();
				return;
			case "leader":
				await player.activateLeader();
				return;
			case "play": {
				const card = this.findInHand(m.card);
				const row = Net.descToRow(m.row);
				if (!card || !row)
					return Net.reportDesync("turn " + game.turnIndex + ": cannot play " + m.card);
				await player.playCardToRow(card, row);
				return;
			}
			case "scorch": {
				const card = this.findInHand(m.card);
				if (!card)
					return Net.reportDesync("turn " + game.turnIndex + ": cannot play " + m.card);
				await player.playScorch(card);
				return;
			}
			case "decoy": {
				const decoy = this.findInHand(m.card);
				const row = Net.descToRow(m.row);
				const target = row ? row.cards.find(c => c.name === m.target && c.isUnit()) : null;
				if (!decoy || !target)
					return Net.reportDesync("turn " + game.turnIndex + ": cannot decoy " + m.target);
				ui.showPreviewVisuals(decoy);
				await sleep(1000);
				ui.hidePreview(decoy);
				board.toHand(target, row);
				await board.moveTo(decoy, row, player.hand);
				player.endTurn();
				return;
			}
		}
		Net.reportDesync("unknown move " + m.kind);
	}

	findInHand(name) {
		return this.player.hand.cards.find(c => c.name === name);
	}

	// Initial redraw of up to two cards
	async redraw() {
		for (let i = 0; i < 2; i++) {
			const m = await Net.next("pick");
			if (m.name === null)
				break;
			const card = this.findInHand(m.name);
			if (!card)
				return Net.reportDesync("redraw: no " + m.name + " in hand");
			this.player.deck.swap(this.player.hand, card);
		}
	}

	// Mirrors a Carousel selection made by the remote player
	async pickCards(container, count, action, predicate) {
		const valid = c => !predicate || predicate(c);
		for (let i = 0; i < count; i++) {
			if (!container.cards.some(valid))
				break;
			const m = await Net.next("pick");
			if (m.name === null)
				break;
			const index = container.cards.findIndex(c => c.name === m.name && valid(c));
			if (index < 0)
				return Net.reportDesync("pick: no " + m.name);
			await action(container, index);
		}
	}

	// Mirrors a row selection (agile units restored by medics / Skellige)
	async pickRow() {
		const m = await Net.next("row");
		return m.row ? Net.descToRow(m.row) : null;
	}

	// Scoia'tael perk: true if the remote player chose to go first
	async pickFirst() {
		const m = await Net.next("first");
		return !!m.self;
	}
}

const Net = {
	transport: null,       // {send(obj), close()}
	peer: null,
	role: null,            // "host" | "guest"
	code: null,
	connected: false,
	inGame: false,
	gameId: 0,
	queue: [],             // in-game moves from the opponent waiting to be consumed
	waiter: null,          // {type, resolve} for the move the simulation waits for
	myName: "",
	opName: "",
	localReady: null,      // deck sent with "ready"
	remoteReady: null,     // deck received with "ready"
	lastDecks: null,       // {me, op} of the last game, for rematches
	hashes: {local: {}, remote: {}},
	desyncReported: false,
	debug: /[?&]debug\b/.test(location.search),
	localMode: /[?&]net=local\b/.test(location.search),
	relayOnly: /[?&]relay\b/.test(location.search),
	attempt: 0,            // bumped on every reset, so a peer created after an await can tell it is stale

	/* ---------------- state queries used by the game ---------------- */

	isConnected() { return this.connected; },
	isOnline() { return this.connected && (this.inGame || game.state === GameState.END_SCREEN || game.state === GameState.PLAYING); },

	/* ---------------- connection ---------------- */

	randomCode() {
		let s = "";
		for (let i = 0; i < NET_CODE_LENGTH; i++)
			s += NET_CODE_ALPHABET[Math.floor(Math.random() * NET_CODE_ALPHABET.length)];
		return s;
	},

	normalizeCode(code) {
		return (code || "").toUpperCase().replace(/[^A-Z0-9]/g, "");
	},

	host() {
		this.resetConnection();
		this.role = "host";
		this.code = this.randomCode();
		NetUI.showHosting(this.code);
		if (this.localMode)
			return this.openLocal();
		if (!this.peerAvailable())
			return;
		this.createPeer(NET_PEER_PREFIX + this.code, peer => this.listenAsHost(peer));
	},

	listenAsHost(peer) {
		peer.on("error", err => {
			if (err.type === "unavailable-id")
				return this.host(); // code already taken - pick another one
			this.onConnectionError(err);
		});
		peer.on("connection", conn => {
			if (this.transport) {
				conn.on("open", () => { conn.send({t: "full"}); setTimeout(() => conn.close(), 500); });
				return;
			}
			this.attachPeerConnection(conn);
		});
	},

	join(rawCode) {
		const code = this.normalizeCode(rawCode);
		if (code.length !== NET_CODE_LENGTH)
			return NetUI.lobbyStatus("Kod gry ma " + NET_CODE_LENGTH + " znaków.", true);
		this.resetConnection();
		this.role = "guest";
		this.code = code;
		NetUI.showJoining(code);
		if (this.localMode)
			return this.openLocal();
		if (!this.peerAvailable())
			return;
		this.createPeer(null, peer => this.listenAsGuest(peer, code));
	},

	listenAsGuest(peer, code) {
		peer.on("open", () => this.attachPeerConnection(peer.connect(NET_PEER_PREFIX + code, {reliable: true, serialization: "json"})));
		peer.on("error", err => {
			if (err.type === "peer-unavailable") {
				this.resetConnection();
				NetUI.showIdle();
				return NetUI.lobbyStatus("Nie znaleziono gry o kodzie " + code + ". Sprawdź kod.", true);
			}
			this.onConnectionError(err);
		});
	},

	peerAvailable() {
		if (typeof Peer !== "undefined")
			return true;
		NetUI.showIdle();
		NetUI.lobbyStatus("Nie udało się wczytać biblioteki PeerJS. Sprawdź połączenie z internetem.", true);
		return false;
	},

	// Creates the Peer once the ICE servers are known. id is null for a random id.
	async createPeer(id, setup) {
		const attempt = this.attempt;
		this.connecting = true;
		const options = {debug: 1, config: {iceServers: await this.iceServers()}};
		if (this.relayOnly || NetConfig.get().relayOnly)
			options.config.iceTransportPolicy = "relay";
		if (attempt !== this.attempt)
			return; // cancelled while waiting
		this.connecting = false;
		const peer = id ? new Peer(id, options) : new Peer(options);
		this.peer = peer;
		setup(peer);
	},

	async iceServers() {
		const cfg = NetConfig.get();
		let servers = Array.isArray(cfg.iceServers) ? cfg.iceServers.slice() : [];
		if (cfg.turnUrls)
			servers.push({urls: cfg.turnUrls, username: cfg.turnUsername || "", credential: cfg.turnCredential || ""});
		if (cfg.credentialsUrl) {
			try {
				const res = await fetch(cfg.credentialsUrl);
				if (!res.ok)
					throw new Error("HTTP " + res.status);
				const list = await res.json();
				if (!Array.isArray(list))
					throw new Error("expected a JSON list of ICE servers");
				servers = servers.concat(list);
			} catch (e) {
				console.warn("[net] could not fetch TURN credentials from credentialsUrl", e);
			}
		}
		if (!servers.length)
			return NET_DEFAULT_ICE_SERVERS;
		// A STUN server lets direct connections work without using the TURN relay
		if (!servers.some(s => [].concat(s.urls).some(u => /^stuns?:/.test(u))))
			servers.unshift(NET_DEFAULT_ICE_SERVERS[0]);
		if (this.debug)
			console.log("[net] ICE servers", servers.map(s => s.urls));
		return servers;
	},

	attachPeerConnection(conn) {
		conn.on("open", () => {
			this.transport = {
				send: obj => conn.send(obj),
				close: () => conn.close()
			};
			this.onConnected();
		});
		conn.on("data", data => this.onMessage(data));
		conn.on("close", () => this.onConnectionLost());
		conn.on("error", err => console.warn("[net] connection error", err));
	},

	// Testing transport: two tabs of the same browser talk over a BroadcastChannel
	openLocal() {
		const channel = new BroadcastChannel("gwent-local-" + this.code);
		const transport = {
			send: obj => channel.postMessage(obj),
			close: () => channel.close()
		};
		channel.onmessage = e => {
			const m = e.data;
			if (m.t === "local-hello" && this.role === "host" && !this.transport) {
				this.transport = transport;
				transport.send({t: "local-welcome"});
				this.onConnected();
			} else if (m.t === "local-welcome" && this.role === "guest" && !this.transport) {
				this.transport = transport;
				this.onConnected();
			} else if (this.transport) {
				this.onMessage(m);
			}
		};
		this.localChannel = channel;
		if (this.role === "guest")
			channel.postMessage({t: "local-hello"});
	},

	onConnected() {
		this.connected = true;
		this.send({t: "hello", name: this.myName, v: NET_PROTOCOL});
		NetUI.onConnected();
	},

	onConnectionError(err) {
		console.warn("[net] peer error", err);
		const wasConnected = this.connected;
		this.resetConnection();
		if (wasConnected)
			return this.handleLostOpponent("Połączenie z przeciwnikiem zostało przerwane.");
		NetUI.showIdle();
		NetUI.lobbyStatus("Błąd połączenia (" + (err.type || err) + "). Spróbuj ponownie.", true);
	},

	onConnectionLost() {
		if (!this.connected)
			return;
		this.resetConnection();
		this.handleLostOpponent("Połączenie z przeciwnikiem zostało przerwane.");
	},

	handleLostOpponent(text) {
		if (this.inGame || game.state !== GameState.CUSTOMIZE)
			this.leaveMatch();
		NetUI.showIdle();
		NetUI.toast(text);
	},

	// Closes everything and goes back to a clean, unconnected state
	resetConnection() {
		this.attempt++;
		this.connecting = false;
		this.connected = false;
		if (this.transport) {
			try { this.transport.close(); } catch (e) {}
		}
		if (this.localChannel) {
			try { this.localChannel.close(); } catch (e) {}
		}
		if (this.peer) {
			try { this.peer.destroy(); } catch (e) {}
		}
		this.transport = this.peer = this.localChannel = null;
		this.localReady = this.remoteReady = null;
		this.lastDecks = null;
		this.opName = "";
	},

	// Called by the player (Disconnect button, starting a game against the AI)
	disconnect() {
		if (!this.transport && !this.peer && !this.localChannel && !this.connecting)
			return;
		this.send({t: "bye"});
		const wasOnline = this.inGame || game.state !== GameState.CUSTOMIZE;
		this.resetConnection();
		if (wasOnline)
			this.abortGame();
		NetUI.showIdle();
	},

	send(obj) {
		if (!this.transport)
			return;
		try {
			this.transport.send(obj);
		} catch (e) {
			console.warn("[net] send failed", e);
		}
	},

	/* ---------------- lobby / match flow ---------------- */

	onMessage(m) {
		if (!m || typeof m !== "object")
			return;
		if (this.debug && m.t !== "sync")
			console.log("[net] <-", JSON.stringify(m));
		switch (m.t) {
			case "hello":
				this.opName = String(m.name || "").slice(0, 16) || "Przeciwnik";
				if (m.v !== NET_PROTOCOL)
					NetUI.toast("Przeciwnik ma inną wersję gry - mogą wystąpić błędy.");
				NetUI.update();
				return;
			case "full":
				this.resetConnection();
				NetUI.showIdle();
				NetUI.lobbyStatus("W tej grze jest już dwóch graczy.", true);
				return;
			case "bye":
				this.resetConnection();
				this.handleLostOpponent("Przeciwnik się rozłączył.");
				return;
			case "ready": {
				const deck = NetDeck.validate(m.deck);
				if (!deck) {
					NetUI.toast("Talia przeciwnika jest nieprawidłowa.");
					return;
				}
				this.remoteReady = m.deck;
				if (game.state === GameState.END_SCREEN)
					NetUI.toast(this.localReady ? "Rewanż!" : "Przeciwnik chce rewanżu. Kliknij Rematch, aby zagrać.");
				NetUI.update();
				this.tryStart();
				return;
			}
			case "unready":
				this.remoteReady = null;
				NetUI.update();
				return;
			case "start":
				if (this.role !== "guest")
					return;
				if (this.localReady && this.remoteReady)
					this.beginGame(m.seed >>> 0, m.gid);
				else
					this.send({t: "lobby"}); // we cancelled at the same moment - the host goes back too
				return;
			case "lobby":
				// opponent left the game / went back to the deck screen
				this.remoteReady = null;
				if (this.inGame || game.state === GameState.END_SCREEN) {
					this.leaveMatch();
					NetUI.toast("Przeciwnik wrócił do wyboru talii.");
				}
				NetUI.update();
				return;
			case "sync":
				if (m.g === this.gameId)
					this.compareHash(m.turn, m.h, m.s, false);
				return;
			case "turn":
			case "pick":
			case "row":
			case "first":
				if (!this.inGame || m.g !== this.gameId)
					return;
				this.queue.push(m);
				this.flushQueue();
				return;
		}
	},

	// Marks the local player as ready with the given deck; toggles back if already ready
	ready(deck) {
		if (this.localReady) {
			this.localReady = null;
			this.send({t: "unready"});
			NetUI.update();
			return;
		}
		this.setReady(deck);
	},

	setReady(deck) {
		this.localReady = deck;
		this.send({t: "ready", deck: deck});
		NetUI.update();
		this.tryStart();
	},

	requestRematch() {
		if (!this.lastDecks || this.localReady)
			return;
		this.setReady(this.lastDecks.me);
		if (!this.remoteReady)
			NetUI.toast("Czekam, aż przeciwnik też kliknie Rematch…");
	},

	// The host starts the match as soon as both players are ready
	tryStart() {
		if (this.role !== "host" || !this.localReady || !this.remoteReady || this.inGame)
			return;
		const seed = SeededRNG.randomSeed();
		const gid = this.gameId + 1;
		this.send({t: "start", seed: seed, gid: gid});
		this.beginGame(seed, gid);
	},

	beginGame(seed, gid) {
		const meDeck = this.localReady, opDeck = this.remoteReady;
		this.localReady = this.remoteReady = null;
		this.lastDecks = {me: meDeck, op: opDeck};
		this.gameId = gid;
		this.queue = [];
		this.waiter = null;
		this.hashes = {local: {}, remote: {}};
		this.desyncReported = false;
		this.inGame = true;

		NetUI.closeLobby();
		NetBoard.clear();
		game.reset();
		game.endScreen.classList.add("hide");
		game.sharedRng = new SeededRNG(SeededRNG.derive(seed, "shared"));
		const opRole = this.role === "host" ? "guest" : "host";
		player_me = new Player(0, this.myName || "Ty", NetDeck.toGameDeck(meDeck), {role: this.role, seed: seed});
		player_op = new Player(1, this.opName || "Przeciwnik", NetDeck.toGameDeck(opDeck), {role: opRole, seed: seed, remote: true});
		dm.elem.classList.add("hide");
		NetUI.update();
		game.startGame();
	},

	// Called by the game when the end screen is shown
	onGameEnded() {
		this.inGame = false;
		this.waiter = null;
		this.queue = [];
		NetUI.setWaiting(false);
	},

	// Leaves the current match and returns to the deck screen (connection stays open)
	backToLobby(notify) {
		if (notify)
			this.send({t: "lobby"});
		this.localReady = null;
		this.leaveMatch();
	},

	leaveMatch() {
		this.abortGame();
		if (game.state !== GameState.CUSTOMIZE)
			game.returnToCustomization();
		NetUI.update();
	},

	// Stops waiting for moves of the current game. Pending waits are dropped, never resolved,
	// so the abandoned game simply stops.
	abortGame() {
		this.inGame = false;
		this.queue = [];
		this.waiter = null;
		NetUI.setWaiting(false);
		if (typeof Carousel !== "undefined" && Carousel.curr)
			Carousel.curr.exit();
		if (ui.carousels)
			ui.carousels = [];
		if (typeof Popup !== "undefined" && Popup.curr)
			Popup.curr.clear();
		ui.hidePreview();
	},

	/* ---------------- moves during a game ---------------- */

	// Sends a decision of the local player. Does nothing outside online games.
	sendMove(m) {
		if (!this.inGame)
			return;
		m.g = this.gameId;
		if (this.debug)
			console.log("[net] ->", JSON.stringify(m));
		this.send(m);
	},

	// Waits for the next decision of the remote player
	next(type) {
		if (!this.inGame)
			return new Promise(() => {});
		return new Promise(resolve => {
			this.waiter = {type: type, resolve: resolve, g: this.gameId};
			this.flushQueue();
		});
	},

	flushQueue() {
		if (!this.waiter) {
			NetUI.setWaiting(false);
			return;
		}
		if (this.queue.length === 0) {
			NetUI.setWaiting(true);
			return;
		}
		const m = this.queue.shift();
		const w = this.waiter;
		this.waiter = null;
		NetUI.setWaiting(false);
		if (m.t !== w.type) {
			this.reportDesync("expected '" + w.type + "', got '" + m.t + "'");
			return;
		}
		w.resolve(m);
	},

	rowToDesc(row) {
		if (row === weather)
			return {w: 1};
		const i = board.row.indexOf(row);
		if (i < 0)
			return null;
		return {side: i >= 3 ? "self" : "opp", type: row.type};
	},

	// Converts a row description from the opponent's point of view to a local row
	descToRow(desc) {
		if (!desc)
			return null;
		if (desc.w)
			return weather;
		const top = desc.side === "self"; // the opponent's own rows are at the top for us
		return board.row.find((r, i) => (i < 3) === top && r.type === desc.type) || null;
	},

	/* ---------------- desync detection ---------------- */

	// Canonical description of the game state, independent of which client computes it
	stateString() {
		// Scores are recalculated from the rows rather than read from the display, because some
		// effects refresh the displayed score only after an animation.
		const parts = [];
		const rowOrder = {close: 0, ranged: 1, siege: 2};
		for (const p of game.playerOrder()) {
			const rows = board.row.filter((r, i) => (p === player_me) === (i >= 3))
				.sort((a, b) => rowOrder[a.type] - rowOrder[b.type]);
			const total = rows.reduce((sum, r) => sum + r.calcScore(), 0);
			const hand = p.hand.cards.concat(p.hand.incoming || []);
			parts.push(p.role, total, p.health, p.passed ? 1 : 0, p.leaderAvailable ? 1 : 0);
			parts.push("D:" + p.deck.cards.map(c => c.name).join(","));
			parts.push("H:" + hand.map(c => c.name).sort().join(","));
			parts.push("G:" + p.grave.cards.map(c => c.name).sort().join(","));
			rows.forEach(r => {
				parts.push(r.type + ":" + r.cards.map(c => c.name + "=" + r.calcCardScore(c)).sort().join(",") + (r.special ? "+" + r.special.name : ""));
			});
		}
		parts.push("W:" + weather.cards.map(c => c.name).sort().join(","));
		parts.push("C:" + (game.currPlayer ? game.currPlayer.role : "-"));
		return parts.join("|");
	},

	checkpoint(turn) {
		if (!this.inGame)
			return;
		const s = this.stateString();
		const h = SeededRNG.derive(0, s);
		this.compareHash(turn, h, this.debug ? s : undefined, true);
		this.send({t: "sync", g: this.gameId, turn: turn, h: h, s: this.debug ? s : undefined});
	},

	compareHash(turn, h, s, isLocal) {
		const mine = isLocal ? this.hashes.local : this.hashes.remote;
		const other = isLocal ? this.hashes.remote : this.hashes.local;
		mine[turn] = {h: h, s: s};
		if (!other[turn])
			return;
		if (other[turn].h !== h) {
			const a = isLocal ? s : other[turn].s, b = isLocal ? other[turn].s : s;
			console.error("[net] state mismatch at turn " + turn, "\nlocal: ", a, "\nremote:", b);
			this.reportDesync("state differs at turn " + turn);
		}
		delete mine[turn];
		delete other[turn];
	},

	reportDesync(detail) {
		console.error("[net] desync:", detail);
		if (this.desyncReported)
			return;
		this.desyncReported = true;
		NetUI.toast("Uwaga: stan gry różni się u obu graczy. Szczegóły w konsoli przeglądarki (F12).", 8000);
	}
};

// Deck (de)serialization for online games
// Reads window.GWENT_NET_CONFIG from net-config.js
const NetConfig = {
	get() {
		const cfg = window.GWENT_NET_CONFIG;
		return cfg && typeof cfg === "object" ? cfg : {};
	}
};

const NetDeck = {
	// Returns the deck if it is a legal deck, otherwise null
	validate(deck) {
		try {
			if (!deck || !factions[deck.faction])
				return null;
			const leader = card_dict[deck.leader];
			if (!leader || leader.row !== "leader" || leader.deck !== deck.faction)
				return null;
			let units = 0, special = 0;
			for (const c of deck.cards) {
				const data = card_dict[c.index];
				if (!data || !(c.count > 0) || c.count > 10)
					return null;
				if (data.row === "leader" || (data.deck !== deck.faction && data.deck !== "neutral" && data.deck !== "special" && data.deck !== "weather"))
					return null;
				if (data.deck === "special" || data.deck === "weather")
					special += c.count;
				else
					units += c.count;
			}
			if (units < 22 || special > 10)
				return null;
			return deck;
		} catch (e) {
			return null;
		}
	},

	toGameDeck(deck) {
		return {
			faction: deck.faction,
			leader: card_dict[deck.leader],
			cards: deck.cards.map(c => ({index: c.index, count: c.count}))
		};
	}
};

// Clears the board's HTML before a new online game so nothing from the previous one remains
const NetBoard = {
	clear() {
		if (player_me) player_me.reset();
		if (player_op) player_op.reset();
		for (const tag of ["me", "op"]) {
			for (const id of ["grave-" + tag, "deck-" + tag]) {
				const el = document.getElementById(id);
				const fresh = el.cloneNode(false); // drops old content and click handlers
				el.parentNode.replaceChild(fresh, el);
			}
			const leader = document.getElementById("leader-" + tag);
			if (leader && leader.children[0])
				leader.children[0].innerHTML = "";
		}
		const hand = document.getElementById("hand-row");
		while (hand.firstChild)
			hand.removeChild(hand.firstChild);
	}
};

// Lobby window, status panel on the deck screen, waiting indicator and messages
const NetUI = {
	init() {
		this.lobby = document.getElementById("online-lobby");
		this.statusLine = document.getElementById("online-lobby-status");
		document.getElementById("play-online").addEventListener("click", () => this.openLobby());
		document.getElementById("online-close").addEventListener("click", () => this.closeLobby());
		document.getElementById("online-host").addEventListener("click", () => { this.saveName(); Net.host(); });
		document.getElementById("online-join").addEventListener("click", () => { this.saveName(); Net.join(document.getElementById("online-code").value); });
		document.getElementById("online-code").addEventListener("keydown", e => { if (e.key === "Enter") document.getElementById("online-join").click(); });
		document.getElementById("online-cancel").addEventListener("click", () => { Net.disconnect(); this.showIdle(); });
		document.getElementById("online-copy").addEventListener("click", () => this.copyCode());
		document.getElementById("online-disconnect").addEventListener("click", () => Net.disconnect());
		document.getElementById("online-opp-disconnect").addEventListener("click", () => Net.disconnect());
		const nameInput = document.getElementById("online-name");
		try { nameInput.value = localStorage.getItem("gwent-online-name") || ""; } catch (e) {}
		Net.myName = nameInput.value.trim();
		window.addEventListener("beforeunload", () => Net.send({t: "bye"}));
		// changing the deck after clicking "Ready" withdraws the ready state
		document.getElementById("deck-customization").addEventListener("click", e => {
			if (Net.localReady && game.state === GameState.CUSTOMIZE
				&& e.target.closest("#card-bank, #card-deck, #card-leader, #change-faction, #upload-deck")) {
				Net.ready();
				this.toast("Talia się zmieniła - kliknij „Gotowy” ponownie.");
			}
		}, true);
		this.startButton = document.getElementById("start-game");
		this.startLabel = this.startButton.innerHTML;
		if (Net.localMode)
			document.getElementById("online-mode-note").classList.remove("hide");
		// a link like index.html#join=ABCDE fills in the code
		const m = location.hash.match(/join=([A-Za-z0-9]+)/);
		if (m) {
			document.getElementById("online-code").value = Net.normalizeCode(m[1]);
			setTimeout(() => this.openLobby(), 300);
		}
		this.showIdle();
	},

	saveName() {
		const name = document.getElementById("online-name").value.trim().slice(0, 16);
		Net.myName = name;
		try { localStorage.setItem("gwent-online-name", name); } catch (e) {}
	},

	openLobby() {
		this.lobby.classList.remove("hide");
		if (!Net.connected && !Net.peer && !Net.localChannel)
			this.showIdle();
	},

	closeLobby() {
		this.lobby.classList.add("hide");
	},

	showPanel(name) {
		for (const id of ["online-idle", "online-wait", "online-connected"])
			document.getElementById(id).classList.toggle("hide", id !== name);
	},

	showIdle() {
		this.showPanel("online-idle");
		this.lobbyStatus("");
		this.update();
	},

	showHosting(code) {
		this.showPanel("online-wait");
		document.getElementById("online-wait-title").innerHTML = "Kod Twojej gry";
		document.getElementById("online-code-display").innerHTML = code;
		document.getElementById("online-copy").classList.remove("hide");
		this.lobbyStatus("Podaj ten kod drugiemu graczowi. Czekam na połączenie…");
	},

	showJoining(code) {
		this.showPanel("online-wait");
		document.getElementById("online-wait-title").innerHTML = "Dołączanie do gry";
		document.getElementById("online-code-display").innerHTML = code;
		document.getElementById("online-copy").classList.add("hide");
		this.lobbyStatus("Łączenie…");
	},

	onConnected() {
		this.showPanel("online-connected");
		this.lobbyStatus("");
		this.update();
		setTimeout(() => this.closeLobby(), 1200);
	},

	lobbyStatus(text, isError) {
		this.statusLine.innerHTML = text;
		this.statusLine.classList.toggle("online-error", !!isError);
	},

	copyCode() {
		const code = Net.code;
		const url = location.origin + location.pathname + location.search + "#join=" + code;
		const done = () => this.lobbyStatus("Skopiowano link do gry. Wyślij go drugiemu graczowi.");
		if (navigator.clipboard)
			navigator.clipboard.writeText(url).then(done, () => this.lobbyStatus("Kod gry: " + code));
		else
			this.lobbyStatus("Link: " + url);
	},

	// Refreshes the deck screen and lobby to match the connection state
	update() {
		const connected = Net.connected;
		const opp = connected ? (Net.opName || "Przeciwnik") : "";
		document.getElementById("opponent-preview").classList.toggle("hide", connected);
		document.getElementById("online-opponent").classList.toggle("hide", !connected);
		document.getElementById("play-online").innerHTML = connected ? "Online: " + Net.code : "Graj online";
		document.getElementById("online-opp-name").innerHTML = this.escape(opp);
		document.getElementById("online-connected-text").innerHTML = "Połączono z: " + this.escape(opp);
		let status;
		if (Net.localReady && Net.remoteReady)
			status = "Start…";
		else if (Net.localReady)
			status = "Czekam, aż przeciwnik będzie gotowy…";
		else if (Net.remoteReady)
			status = "Przeciwnik jest gotowy";
		else
			status = "Wybierz talię i kliknij „Gotowy”";
		document.getElementById("online-opp-status").innerHTML = status;
		this.startButton.innerHTML = !connected ? this.startLabel : Net.localReady ? "Anuluj" : "Gotowy";
		this.startButton.classList.toggle("online-ready", connected && !!Net.localReady);
	},

	// Shows "opponent's move" while the game waits for the opponent and the local player
	// has nothing to decide (no card choice or popup open)
	setWaiting(waiting) {
		this.waiting = waiting;
		if (!this.waitTimer)
			this.waitTimer = setInterval(() => this.refreshWaiting(), 250);
		this.refreshWaiting();
	},

	refreshWaiting() {
		const el = document.getElementById("online-waiting");
		const busy = (typeof Carousel !== "undefined" && Carousel.curr) || (typeof Popup !== "undefined" && Popup.curr);
		if (el)
			el.classList.toggle("hide", !this.waiting || !Net.inGame || !!busy);
	},

	toast(text, duration = 4500) {
		const el = document.getElementById("online-toast");
		el.innerHTML = this.escape(text);
		el.classList.remove("hide");
		clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => el.classList.add("hide"), duration);
	},

	escape(text) {
		return String(text).replace(/[&<>"']/g, c => ({"&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"}[c]));
	}
};
