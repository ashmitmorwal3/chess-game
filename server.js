const express = require('express');
const WebSocket = require('ws');
const { Chess } = require('chess.js');
const path = require('path');

const app = express();
// Use process.env.PORT provided by Railway
const PORT = process.env.PORT || 3000; // fallback to 3000 for local development

// Serve static files for the frontend
app.use(express.static(path.join(__dirname, 'public')));

const server = app.listen(PORT, () => {
    console.log(`Server running on http://localhost:${PORT}`);
});

// WebSocket setup
const wss = new WebSocket.Server({ server });

// Store connected players and spectators
let players = [];
let spectators = [];

// Map to store games
const games = new Map();

// Helper function to broadcast messages
const broadcast = (gameId, message) => {
    const game = games.get(gameId);
    if (game) {
        [...game.players, ...game.spectators].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
};

wss.on('connection', (ws) => {
    console.log('A client connected.');

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'join':
                    if (players.length < 2) {
                        players.push(ws);
                        ws.playerName = data.name; // Store the player's name
                        const playerId = players.length;
                        ws.send(JSON.stringify({ type: 'welcome', playerId, name: ws.playerName }));

                        // Start the game if two players are connected
                        if (players.length === 2) {
                            const gameId = Date.now().toString();
                            const chess = new Chess();
                            games.set(gameId, { players, spectators: [], chess, currentTurn: 'white' });

                            players.forEach((player, index) => {
                                const color = index === 0 ? 'white' : 'black';
                                const flipped = index === 1;

                                player.send(JSON.stringify({
                                    type: 'start',
                                    gameId,
                                    color,
                                    flipped,
                                    firstPlayer: index === 0 ? 'white' : 'black', // First player
                                }));
                            });

                            broadcast(gameId, { type: 'turn', turn: 'white' }); // Notify white's turn first

                            ws.gameId = gameId;
                            ws.chess = chess;
                        }
                    } else {
                        // Add to spectators if game is full
                        spectators.push(ws);
                        ws.send(JSON.stringify({ type: 'spectator', message: 'You are watching the game as a spectator.' }));
                        const activeGame = Array.from(games.values())[0];
                        if (activeGame) {
                            ws.gameId = activeGame.gameId;
                            ws.send(JSON.stringify({ type: 'spectator', gameId: activeGame.gameId }));
                        }
                    }
                    break;

                case 'move':
                    const { gameId, from, to, color } = data;
                    const game = games.get(gameId);

                    if (!game) {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid game.' }));
                        return;
                    }

                    const chess = game.chess;

                    // Check if it's the player's turn
                    if (game.currentTurn !== color) {
                        ws.send(JSON.stringify({ type: 'error', message: 'It\'s not your turn yet.' }));
                        return;
                    }

                    // Make the move
                    const move = chess.move({ from, to });

                    if (move) {
                        // Broadcast the move to all players and spectators
                        broadcast(gameId, { type: 'move', move: { from, to } });

                        // Add move to the game log (for future broadcast or player updates)
                        game.moveHistory = game.moveHistory || [];
                        game.moveHistory.push({ from, to });

                        // Switch turn
                        game.currentTurn = game.currentTurn === 'white' ? 'black' : 'white';
                        broadcast(gameId, { type: 'turn', turn: game.currentTurn });

                        // Check for game over
                        if (chess.game_over()) {
                            const result = chess.in_checkmate() ? 'checkmate' : 'draw';
                            broadcast(gameId, { type: 'game_over', result });
                            games.delete(gameId);
                        }
                    } else {
                        ws.send(JSON.stringify({ type: 'error', message: 'Invalid move.' }));
                    }
                    break;

                default:
                    ws.send(JSON.stringify({ type: 'error', message: 'Unknown message type.' }));
            }
        } catch (err) {
            console.error('Error processing message:', err);
            ws.send(JSON.stringify({ type: 'error', message: 'Invalid message format.' }));
        }
    });

    ws.on('close', () => {
        console.log('A client disconnected.');

        // Handle player disconnection
        players = players.filter(player => player !== ws);
        spectators = spectators.filter(spectator => spectator !== ws);

        if (ws.gameId && games.has(ws.gameId)) {
            const game = games.get(ws.gameId);
            game.players = game.players.filter(player => player !== ws);
            
            if (game.players.length === 0) {
                games.delete(ws.gameId); // Clean up the game if no players are left
            } else {
                // Notify the remaining player if a player disconnects
                broadcast(ws.gameId, { type: 'error', message: 'A player disconnected. Game over.' });
            }
        }
    });

    ws.on('error', (err) => {
        console.error('WebSocket error:', err);
        ws.send(JSON.stringify({ type: 'error', message: 'An unexpected error occurred.' }));
    });
});
