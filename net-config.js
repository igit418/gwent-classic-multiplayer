"use strict"

/*
 * Network settings for online games: STUN/TURN servers used by WebRTC.
 *
 * Without a TURN server two players behind strict NATs (some company or mobile networks)
 * cannot connect. A TURN server relays the traffic when a direct connection fails.
 * See the "Serwer TURN" section of ONLINE.md for how to get one for free.
 *
 * Everything in this file is sent to the players' browsers, so it is public. Use TURN
 * credentials meant for browsers, e.g. a Metered.ca credentials API key (not the secret key).
 *
 * Options (all optional):
 *   iceServers      - list of RTCIceServer objects, used as given
 *   turnUrls        - TURN address or list, e.g. "turn:global.relay.metered.ca:80"
 *   turnUsername    - username for turnUrls
 *   turnCredential  - password for turnUrls
 *   credentialsUrl  - URL that returns a JSON list of RTCIceServer objects (e.g. the Metered
 *                     credentials API); fetched when a game is created or joined
 *   relayOnly       - true forces traffic through TURN (for testing; ?relay in the URL does the same)
 *
 * Example (Metered.ca):
 *   window.GWENT_NET_CONFIG = {
 *       credentialsUrl: "https://<your-app>.metered.live/api/v1/turn/credentials?apiKey=<API key>"
 *   };
 */
window.GWENT_NET_CONFIG = window.GWENT_NET_CONFIG || {};
