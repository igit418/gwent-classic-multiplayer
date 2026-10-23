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
 *
 * All messages are written from the sender's point of view ("self" = the sender).
 *
 * Resuming: each client keeps the match (seed, decks and every move of both players) in
 * sessionStorage. After a page reload the game is rebuilt by replaying that log on a fast
 * virtual clock, while the connection is re-established. Moves are numbered, so after
 * reconnecting both sides resend whatever the other one missed.
 */

const NET_PROTOCOL = 2;
const NET_SESSION_VERSION = 1;
const NET_SESSION_KEY = "gwent-online-session";
const NET_SESSION_MAX_AGE = 15 * 60 * 1000;   // a saved match older than this is not resumed
const NET_RECONNECT_TIME = 3 * 60 * 1000;     // how long to wait for the opponent to come back
const NET_RECONNECT_INTERVAL = 3;             // seconds between reconnection attempts
const NET_PEER_PREFIX = "gwentclassic-online-";
const NET_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const NET_CODE_LENGTH = 5;

// Controls the opponent in an online game: waits for that player's decisions to arrive
class ControllerRemote {
	constructor(player) {
		this.player = player;
	}

	// The next decision of this player. Resolves to null when there is none (see ControllerReplay).
	next(type) {
		return Net.next(type);
	}

	// Plays out the remote player's turn
	async startTurn(player) {
		const m = await this.next("turn");
		if (!m)
			return; // the local player takes the turn through the UI
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
			const m = await this.next("pick");
			if (m.name === null)
				break;
			const card = this.findInHand(m.name);
			if (!card)
				return Net.reportDesync("redraw: no " + m.name + " in hand");
			this.player.deck.swap(this.player.hand, card);
		}
	}

	// Mirrors a Carousel selection made by the remote player
	// carouselArgs: [bSort, bQuit, title] for showing the rest of the choice to the local player
	async pickCards(container, count, action, predicate, carouselArgs = []) {
		const valid = c => !predicate || predicate(c);
		for (let i = 0; i < count; i++) {
			if (!container.cards.some(valid))
				break;
			const m = await this.next("pick");
			if (!m)
				return await ui.queueCarousel(container, count - i, action, predicate, ...carouselArgs);
			if (m.name === null)
				break;
			const index = container.cards.findIndex(c => c.name === m.name && valid(c));
			if (index < 0)
				return Net.reportDesync("pick: no " + m.name);
			await action(container, index);
		}
	}

	// Mirrors a row selection (agile units restored by medics / Skellige)
	async pickRow(card) {
		const m = await this.next("row");
		if (!m)
			return await ui.waitForRowSelection(card);
		return m.row ? Net.descToRow(m.row) : null;
	}

	// Scoia'tael perk: true if the remote player chose to go first
	async pickFirst(player) {
		const m = await this.next("first");
		if (!m) {
			await factions.scoiatael.askFirst(player);
			return game.firstPlayer === player;
		}
		return !!m.self;
	}
}

// Controls the local player while a match is rebuilt after a page reload: plays back the
// decisions saved before the reload. When they run out, the game hands control back to the UI.
class ControllerReplay extends ControllerRemote {
	next(type) {
		return NetReplay.next(type);
	}
}

// Virtual time for fast-forwarding a match. sleep() calls are resolved one by one in the order
// of their deadlines, as real timers would be, but without waiting.
const NetClock = {
	active: false,
	now: 0,
	seq: 0,
	timers: [],
	scheduled: false,
	channel: null,

	start() {
		this.active = true;
		this.now = 0;
		this.timers = [];
		if (!this.channel) {
			// MessageChannel instead of setTimeout(0), which browsers slow down to 4 ms when nested
			this.channel = new MessageChannel();
			this.channel.port1.onmessage = () => this.step();
		}
	},

	sleep(ms) {
		return new Promise(resolve => {
			this.timers.push({at: this.now + Math.max(0, Number(ms) || 0), seq: this.seq++, resolve: resolve});
			this.kick();
		});
	},

	kick() {
		if (this.scheduled || !this.active)
			return;
		this.scheduled = true;
		this.channel.port2.postMessage(0);
	},

	// Runs the earliest timer; the game's reaction to it runs before the next step
	step() {
		this.scheduled = false;
		if (!this.active)
			return;
		if (this.timers.length === 0)
			return NetReplay.onIdle();
		let best = 0;
		for (let i = 1; i < this.timers.length; i++) {
			const t = this.timers[i], b = this.timers[best];
			if (t.at < b.at || (t.at === b.at && t.seq < b.seq))
				best = i;
		}
		const timer = this.timers.splice(best, 1)[0];
		this.now = timer.at;
		NetReplay.idleSince = 0;
		timer.resolve();
		this.kick();
	},

	// Back to real time; timers still waiting continue as real ones
	stop() {
		this.active = false;
		for (const t of this.timers)
			setTimeout(t.resolve, t.at - this.now);
		this.timers = [];
	},

	// Drops everything (the fast-forwarded game is abandoned)
	cancel() {
		this.active = false;
		this.timers = [];
	}
};

// Plays the local player's saved decisions back after a page reload
const NetReplay = {
	active: false,
	moves: [],
	index: 0,
	idleSince: 0,
	finished: null,
	resolveFinished: null,

	start(moves) {
		// moves were written from the local player's point of view, the controller reads them
		// like moves of the opponent, so rows are mirrored
		this.moves = moves.map(m => m.row ? Object.assign({}, m, {row: NetReplay.flipRow(m.row)}) : m);
		this.index = 0;
		this.idleSince = 0;
		this.active = true;
		this.finished = new Promise(resolve => this.resolveFinished = resolve);
		player_me.controller = new ControllerReplay(player_me);
		NetClock.start();
		NetUI.setReplaying(true);
	},

	flipRow(desc) {
		if (desc.w)
			return desc;
		return {side: desc.side === "self" ? "opp" : "self", type: desc.type};
	},

	// The next saved decision, or null (after the replay has ended) when there are no more
	next(type) {
		if (this.active && this.index < this.moves.length) {
			const m = this.moves[this.index++];
			if (m.t !== type)
				Net.reportDesync("replay: expected '" + type + "', saved '" + m.t + "'");
			return Promise.resolve(m);
		}
		return this.finished.then(() => null);
	},

	// Called when the game has nothing left to do on the virtual clock
	onIdle() {
		if (!this.active)
			return;
		if (this.index >= this.moves.length || game.state !== GameState.PLAYING)
			return this.finish();
		// still waiting for something that runs in real time - look again shortly
		if (!this.idleSince)
			this.idleSince = Date.now();
		if (Date.now() - this.idleSince > 10000) {
			Net.reportDesync("replay stalled with " + (this.moves.length - this.index) + " saved moves left");
			return this.finish();
		}
		setTimeout(() => NetClock.kick(), 50);
	},

	finish() {
		if (!this.active)
			return;
		this.active = false;
		NetClock.stop();
		player_me.controller = new Controller();
		NetUI.setReplaying(false);
		this.resolveFinished();
		Net.flushQueue();
	},

	cancel() {
		if (!this.active)
			return;
		this.active = false;
		NetClock.cancel();
		NetUI.setReplaying(false);
	}
};

// The current match saved in sessionStorage (survives a page reload, separate for every tab)
const NetStore = {
	save(session) {
		session.savedAt = Date.now();
		try { sessionStorage.setItem(NET_SESSION_KEY, JSON.stringify(session)); } catch (e) {}
	},

	load() {
		try {
			const s = JSON.parse(sessionStorage.getItem(NET_SESSION_KEY));
			if (!s || s.v !== NET_SESSION_VERSION || !(Date.now() - s.savedAt < NET_SESSION_MAX_AGE))
				return null;
			if (!Array.isArray(s.my) || !Array.isArray(s.op) || !NetDeck.validate(s.decks.me) || !NetDeck.validate(s.decks.op))
				return null;
			if ((s.role !== "host" && s.role !== "guest") || !s.code)
				return null;
			return s;
		} catch (e) {
			return null;
		}
	},

	clear() {
		try { sessionStorage.removeItem(NET_SESSION_KEY); } catch (e) {}
	}
};

const Net = {
	transport: null,       // {send(obj), close()}
	conn: null,            // current PeerJS data connection
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
	session: null,         // the current match, see NetStore
	reconnecting: false,   // the connection was lost during a match and is being restored
	reconnectDeadline: 0,
	reconnectTimer: null,
	reconnectTicks: 0,
	debug: /[?&]debug\b/.test(location.search),
	localMode: /[?&]net=local\b/.test(location.search),

	/* ---------------- state queries used by the game ---------------- */

	isConnected() { return this.connected; },
	isOnline() { return (this.connected || this.reconnecting) && (this.inGame || game.state === GameState.END_SCREEN || game.state === GameState.PLAYING); },

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
		this.createHostPeer();
	},

	createHostPeer() {
		const peer = new Peer(NET_PEER_PREFIX + this.code, {debug: 1});
		this.peer = peer;
		peer.on("error", err => {
			if (peer !== this.peer)
				return;
			if (err.type === "unavailable-id") {
				if (this.reconnecting) {
					// the code is still held by the page before the reload - try again soon
					peer.destroy();
					this.peer = null;
					return;
				}
				return this.host(); // code already taken - pick another one
			}
			this.onConnectionError(err);
		});
		peer.on("connection", conn => {
			if (this.session)
				return this.attachPendingConnection(conn);
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
		this.createGuestPeer();
	},

	createGuestPeer() {
		const peer = new Peer({debug: 1});
		this.peer = peer;
		peer.on("open", () => { if (peer === this.peer) this.connectToHost(); });
		peer.on("error", err => {
			if (peer !== this.peer)
				return;
			if (err.type === "peer-unavailable") {
				if (this.reconnecting)
					return; // the host is not back yet - the next attempt follows
				const code = this.code;
				this.resetConnection();
				NetUI.showIdle();
				return NetUI.lobbyStatus("Nie znaleziono gry o kodzie " + code + ". Sprawdź kod.", true);
			}
			this.onConnectionError(err);
		});
	},

	connectToHost() {
		this.attachPeerConnection(this.peer.connect(NET_PEER_PREFIX + this.code, {reliable: true, serialization: "json"}));
	},

	peerAvailable() {
		if (typeof Peer !== "undefined")
			return true;
		NetUI.showIdle();
		NetUI.lobbyStatus("Nie udało się wczytać biblioteki PeerJS. Sprawdź połączenie z internetem.", true);
		return false;
	},

	attachPeerConnection(conn) {
		conn.on("open", () => {
			if (this.transport) {
				conn.close(); // an older reconnection attempt got through as well
				return;
			}
			this.adoptConnection(conn);
		});
		conn.on("data", data => { if (conn === this.conn) this.onMessage(data); });
		conn.on("close", () => { if (conn === this.conn) this.onConnectionLost(); });
		conn.on("error", err => console.warn("[net] connection error", err));
	},

	// Makes conn the connection to the opponent, replacing the previous one
	adoptConnection(conn) {
		const old = this.conn;
		this.conn = conn;
		this.transport = {
			send: obj => conn.send(obj),
			close: () => conn.close()
		};
		if (old && old !== conn) {
			try { old.close(); } catch (e) {}
		}
		this.onConnected();
	},

	// During a match the host only lets in the opponent coming back, who proves it with the
	// match key. The old connection may not have noticed yet that the opponent is gone.
	attachPendingConnection(conn) {
		const early = [];
		const timer = setTimeout(() => { if (conn !== this.conn) conn.close(); }, 10000);
		conn.on("data", data => {
			if (conn === this.conn)
				return this.onMessage(data);
			if (!data || typeof data !== "object")
				return;
			if (data.t === "resume" && this.session && data.key === this.session.key) {
				clearTimeout(timer);
				this.adoptConnection(conn);
				early.forEach(m => this.onMessage(m));
				this.onMessage(data);
			} else if (data.t === "hello") {
				early.push(data);
			} else {
				conn.send({t: "full"});
				setTimeout(() => conn.close(), 500);
			}
		});
		conn.on("close", () => { if (conn === this.conn) this.onConnectionLost(); });
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
		if (this.session) {
			// tell the opponent how many of its moves we have, it resends the rest
			this.send({t: "resume", g: this.session.gid, recv: this.session.op.length, key: this.session.key});
			const wasReconnecting = this.reconnecting;
			this.stopReconnect();
			NetUI.update();
			if (wasReconnecting)
				NetUI.toast("Połączono ponownie z przeciwnikiem.");
			return;
		}
		NetUI.onConnected();
	},

	onConnectionError(err) {
		console.warn("[net] peer error", err);
		if (this.session) {
			// a broken link to the PeerJS server does not end the match: the data connection may
			// still work, and if it breaks, its "close" event starts reconnecting
			if (this.peer && (this.peer.destroyed || err.type === "unavailable-id")) {
				try { this.peer.destroy(); } catch (e) {}
				this.peer = null;
			}
			return;
		}
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
		if (this.session)
			return this.startReconnect(false);
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
		this.connected = false;
		this.stopReconnect();
		this.clearSession();
		if (this.transport) {
			try { this.transport.close(); } catch (e) {}
		}
		if (this.localChannel) {
			try { this.localChannel.close(); } catch (e) {}
		}
		if (this.peer) {
			try { this.peer.destroy(); } catch (e) {}
		}
		this.transport = this.conn = this.peer = this.localChannel = null;
		this.localReady = this.remoteReady = null;
		this.lastDecks = null;
		this.opName = "";
	},

	/* ---------------- resuming a match ---------------- */

	// Loads a match saved before a page reload, rebuilds it and reconnects. True if resumed.
	restore() {
		const s = NetStore.load();
		if (!s)
			return false;
		if (!this.localMode && typeof Peer === "undefined") {
			NetUI.toast("Nie udało się wczytać biblioteki PeerJS - nie można wznowić partii.");
			NetStore.clear();
			return false;
		}
		this.session = s;
		this.role = s.role;
		this.code = s.code;
		this.myName = s.myName;
		this.opName = s.opName;
		this.launchGame(true);
		this.startReconnect(true);
		return true;
	},

	// Keeps the match and tries to get the connection back.
	// selfReloaded: this page was reloaded (otherwise the opponent disappeared).
	startReconnect(selfReloaded) {
		this.connected = false;
		this.transport = null;
		const old = this.conn;
		this.conn = null;
		if (old) {
			try { old.close(); } catch (e) {}
		}
		this.reconnecting = true;
		this.selfReloaded = selfReloaded;
		this.reconnectDeadline = Date.now() + NET_RECONNECT_TIME;
		this.reconnectTicks = 0;
		clearInterval(this.reconnectTimer);
		this.reconnectTimer = setInterval(() => this.reconnectTick(), 1000);
		this.reconnectTick();
	},

	reconnectTick() {
		if (!this.reconnecting)
			return;
		const left = this.reconnectDeadline - Date.now();
		if (left <= 0)
			return this.giveUpReconnect("Przeciwnik nie wrócił do gry. Partia została przerwana.");
		NetUI.showReconnect(this.selfReloaded, Math.ceil(left / 1000));
		if (!this.transport && this.reconnectTicks++ % NET_RECONNECT_INTERVAL === 0)
			this.tryReconnect();
	},

	tryReconnect() {
		if (this.localMode) {
			if (!this.localChannel)
				this.openLocal();
			else if (this.role === "guest")
				this.localChannel.postMessage({t: "local-hello"});
			return;
		}
		if (typeof Peer === "undefined")
			return;
		const peer = this.peer;
		if (!peer || peer.destroyed)
			return this.role === "host" ? this.createHostPeer() : this.createGuestPeer();
		if (peer.disconnected) {
			try { peer.reconnect(); } catch (e) {}
			return;
		}
		if (this.role === "guest" && peer.open)
			this.connectToHost();
	},

	stopReconnect() {
		this.reconnecting = false;
		clearInterval(this.reconnectTimer);
		this.reconnectTimer = null;
		NetUI.hideReconnect();
	},

	// Ends a match whose opponent did not come back (also the "End match" button)
	giveUpReconnect(text) {
		this.send({t: "bye"});
		this.resetConnection();
		this.leaveMatch();
		NetUI.showIdle();
		if (text)
			NetUI.toast(text);
	},

	clearSession() {
		this.session = null;
		NetStore.clear();
	},

	// Called by the player (Disconnect button, starting a game against the AI)
	disconnect() {
		if (!this.transport && !this.peer && !this.localChannel)
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
				if (this.session) {
					this.session.opName = this.opName;
					NetStore.save(this.session);
				}
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
			case "away":
				// the opponent's page is closing or reloading
				if (this.session)
					return this.startReconnect(false);
				this.resetConnection();
				this.handleLostOpponent("Przeciwnik się rozłączył.");
				return;
			case "resume":
				if (!this.session || m.g !== this.session.gid) {
					// we no longer play that match
					this.send({t: "lobby"});
					return;
				}
				this.session.my.slice(Math.max(0, m.recv | 0)).forEach(x => this.send(x));
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
					this.beginGame(m.seed >>> 0, m.gid, String(m.key || ""));
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
				if (!this.inGame || m.g !== this.gameId || !this.session)
					return;
				if (typeof m.n === "number") {
					if (m.n < this.session.op.length)
						return; // already have it (resent after reconnecting)
					if (m.n > this.session.op.length) {
						// a move went missing - ask for everything from the first missing one
						this.send({t: "resume", g: this.session.gid, recv: this.session.op.length, key: this.session.key});
						return;
					}
				}
				this.session.op.push(m);
				NetStore.save(this.session);
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
		const key = SeededRNG.randomSeed().toString(36) + SeededRNG.randomSeed().toString(36);
		this.send({t: "start", seed: seed, gid: gid, key: key});
		this.beginGame(seed, gid, key);
	},

	beginGame(seed, gid, key) {
		const meDeck = this.localReady, opDeck = this.remoteReady;
		this.localReady = this.remoteReady = null;
		this.session = {
			v: NET_SESSION_VERSION, role: this.role, code: this.code, myName: this.myName, opName: this.opName,
			gid: gid, seed: seed, key: key, decks: {me: meDeck, op: opDeck}, my: [], op: []
		};
		NetStore.save(this.session);
		this.launchGame(false);
	},

	// Sets up the board for the saved match. replay: rebuild it from the saved moves.
	launchGame(replay) {
		const s = this.session;
		const seed = s.seed;
		const meDeck = s.decks.me, opDeck = s.decks.op;
		this.lastDecks = {me: meDeck, op: opDeck};
		this.gameId = s.gid;
		this.queue = replay ? s.op.slice() : [];
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
		if (replay)
			NetReplay.start(s.my);
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
		NetReplay.cancel();
		this.clearSession();
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
		if (!this.inGame || NetReplay.active || !this.session)
			return;
		m.g = this.gameId;
		m.n = this.session.my.length;
		this.session.my.push(m);
		NetStore.save(this.session); // saved before sending, so a reload cannot lose it
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
		if (!this.inGame || NetReplay.active)
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
		// during a match the opponent waits for us to come back (the page may only be reloading)
		window.addEventListener("beforeunload", () => Net.send({t: Net.session ? "away" : "bye"}));
		document.getElementById("online-reconnect-end").addEventListener("click", () => Net.giveUpReconnect("Partia została przerwana."));
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
		this.showIdle();
		if (Net.restore())
			return;
		// a link like index.html#join=ABCDE fills in the code
		const m = location.hash.match(/join=([A-Za-z0-9]+)/);
		if (m) {
			document.getElementById("online-code").value = Net.normalizeCode(m[1]);
			setTimeout(() => this.openLobby(), 300);
		}
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

	// Covers the board while a match is fast-forwarded after a reload
	setReplaying(on) {
		document.getElementById("online-replay").classList.toggle("hide", !on);
	},

	// Banner shown while the connection to the opponent is being restored
	showReconnect(selfReloaded, secondsLeft) {
		const time = Math.floor(secondsLeft / 60) + ":" + String(secondsLeft % 60).padStart(2, "0");
		document.getElementById("online-reconnect-text").innerHTML = (selfReloaded
			? "Wznawianie połączenia z przeciwnikiem…"
			: "Przeciwnik stracił połączenie. Czekam na jego powrót…") + " (" + time + ")";
		document.getElementById("online-reconnect").classList.remove("hide");
	},

	hideReconnect() {
		document.getElementById("online-reconnect").classList.add("hide");
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
