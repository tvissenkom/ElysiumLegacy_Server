// server.js
const express = require('express');
const http = require('http');
const cors = require("cors");
const { Server } = require("socket.io");
const path = require('path');

const app = express();

app.use(cors({
    origin: "*",
    methods: ["GET", "POST"],
}));

const server = http.createServer(app);

const io = new Server(server, {
    cors: { // Allow connections from different origins (like your WebGL client)
        origin: "*", // Be more specific in production!
        methods: ["GET", "POST"]
    }
});

const PORT = process.env.PORT || 3000; // Use environment variable or default to 3000

// --- Game State (Simple Example) ---
let rooms = {}; // Store room information { roomCode: { gameSocketId: null, players: {} } }
let nextPlayerId = 1;

// --- Serve the WebGL Client ---
// Assumes your WebGL build is in a 'public' folder within your server directory
app.use(express.static(path.join(__dirname, 'public')));

// Serve the index.html for the root path
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});


// --- Socket.IO Logic ---
io.on('connection', (socket) => {
    console.log('A user connected:', socket.id);

    // == Game Client (Unity Desktop) Events ==
    socket.on('createRoom', (callback) => {
        let roomCode;
        do {
            roomCode = Math.random().toString(36).substring(2, 7).toUpperCase(); // Generate simple 5-char code
        } while (rooms[roomCode]); // Ensure code is unique

        rooms[roomCode] = {
            gameSocketId: socket.id,
            players: {} // { playerId: { socketId: '...', name: '...' } }
        };
        socket.join(roomCode); // Game client joins the room
        console.log(`Room created: ${roomCode} by game ${socket.id}`);
        callback(roomCode); // Send the room code back to the game client
    });

    // Forward messages from game to specific player(s) or all players in room
    socket.on('messageToPlayer', (data) => { // { roomCode, playerId, eventName, payload }
        const player = rooms[data.roomCode]?.players[data.playerId];
        if (player) {
            io.to(player.socketId).emit(data.eventName, data.payload);
        }
    });
    socket.on('messageToRoom', (data) => { // { roomCode, eventName, payload }
        // Send to all players *except* the game client itself if needed
        io.to(data.roomCode).except(rooms[data.roomCode]?.gameSocketId).emit(data.eventName, data.payload);
    });


    // == Player Client (WebGL) Events ==
    socket.on('joinRoom', (data, callback) => { // data = { roomCode, playerName }
        const roomCode = data.roomCode.toUpperCase();
        const room = rooms[roomCode];

        if (room) {
            const playerId = nextPlayerId++;
            room.players[playerId] = { socketId: socket.id, name: data.playerName || `Player ${playerId}` };
            socket.join(roomCode); // Player joins the room

            console.log(`Player <span class="math-inline">\{playerId\} \(</span>{data.playerName}) joined room ${roomCode}`);

            // Notify the game client
            io.to(room.gameSocketId).emit('playerJoined', {
                playerId: playerId,
                playerName: room.players[playerId].name
            });

            // Notify the player they joined successfully
            callback({ success: true, playerId: playerId, roomCode: roomCode });

            // Optional: Notify other players
            socket.to(roomCode).except(room.gameSocketId).emit('otherPlayerJoined', { playerId: playerId, playerName: room.players[playerId].name });

        } else {
            console.log(`Player ${socket.id} failed to join non-existent room ${roomCode}`);
            callback({ success: false, message: 'Room not found.' });
        }
    });

    socket.on('reconnectPlayer', (data, callback) => {
        if (!data || typeof data !== 'object') {
            console.warn('Invalid reconnectPlayer payload:', data);
            return callback?.({ success: false, message: 'Invalid payload' });
        }
        const { roomCode, playerId } = data;
        const room = rooms[roomCode];

        if (!room) {
            return callback({ success: false, message: 'Room not found.' });
        }

        const player = room.players[playerId];
        if (player && player.disconnected) {
            player.socketId = socket.id;
            player.disconnected = false;
            socket.join(roomCode);

            console.log(`Player ${playerId} reconnected to room ${roomCode}`);

            // Notify the game client
            const playerName = room.players[playerId].name;
            io.to(room.gameSocketId).emit('playerJoined', {
                playerId,
                playerName,
                //reconnected: true // optional flag
            });

            // Acknowledge to the player
            callback({ success: true, playerId, playerName: player.name });
        } else {
            callback({ success: false, message: 'No matching disconnected player found.' });
        }
    });

    socket.onAny((event, ...args) => {
        console.log('Received event:', event, 'Args:', args);
    });

    // Receive input from a player and forward it to the game client
    socket.on('playerInput', (data) => { // data = { roomCode, playerId, inputType, value }
        const room = rooms[data.roomCode];
        if (room && room.players[data.playerId]?.socketId === socket.id) {
            console.log(`Input from player ${data.playerId} in room ${data.roomCode}:`, data.value);
            // Forward to the game client
            io.to(room.gameSocketId).emit('inputReceived', {
                playerId: data.playerId,
                inputType: data.inputType,
                value: data.value
            });
        } else {
            console.warn("Invalid playerInput received:", data);
            // Maybe notify sender? socket.emit('inputError', 'Invalid input attempt');
        }
    });


    // == Disconnect Handling ==
    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        // Find which room/player this socket belonged to and clean up
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            // Check if it was the game client
            if (room.gameSocketId === socket.id) {
                console.log(`Game client for room ${roomCode} disconnected. Closing room.`);
                // Notify all players in the room
                io.to(roomCode).emit('gameEnded', 'The host disconnected.');
                // Optionally kick players or just delete room
                delete rooms[roomCode];
                break; // Exit loop once found
            }

            // Check if it was a player client
            for (const playerId in room.players) {
                if (room.players[playerId].socketId === socket.id) {
                    console.log(`Player ${playerId} disconnected from room ${roomCode}`);
                    const player = room.players[playerId];
                    player.disconnected = true;
                    player.socketId = null; // Clear socket ID
                    io.to(room.gameSocketId).emit('playerDisconnected', { playerId, playerName: player.name });
                    break;
                }
            }
        }
    });
});

server.listen(PORT, () => {
    console.log(`Server listening on *:${PORT}`);
});