// ================================
// SERVER.JS - Backend Server
// ================================
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// Middleware  
app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));
app.use(compression());
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// Game rooms storage
const rooms = new Map();
const players = new Map();

// Room ID generator
function generateRoomId() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Game state management
class GameRoom {
    constructor(roomId, creatorId, creatorName) {
        this.id = roomId;
        this.players = [
            { 
                id: creatorId, 
                name: creatorName, 
                emoji: '⚫', 
                playerNumber: 1,
                connected: true 
            }
        ];
        this.board = Array(8).fill().map(() => Array(8).fill(0));
        this.currentPlayer = 1;
        this.gameStarted = false;
        this.gameOver = false;
        this.winner = null;
        this.spectators = [];
        this.lastActivity = Date.now();
        
        // Initialize starting position
        this.board[3][3] = 2;
        this.board[3][4] = 1;
        this.board[4][3] = 1;
        this.board[4][4] = 2;
    }

    addPlayer(playerId, playerName) {
        if (this.players.length >= 2) {
            return false;
        }
        
        this.players.push({
            id: playerId,
            name: playerName,
            emoji: '⚪',
            playerNumber: 2,
            connected: true
        });
        
        if (this.players.length === 2) {
            this.gameStarted = true;
        }
        
        return true;
    }

    removePlayer(playerId) {
        const playerIndex = this.players.findIndex(p => p.id === playerId);
        if (playerIndex !== -1) {
            this.players[playerIndex].connected = false;
        }
    }

    reconnectPlayer(playerId) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.connected = true;
            return true;
        }
        return false;
    }

    getGameState() {
        return {
            roomId: this.id,
            board: this.board,
            players: this.players,
            currentPlayer: this.currentPlayer,
            gameStarted: this.gameStarted,
            gameOver: this.gameOver,
            winner: this.winner,
            scores: this.getScores(),
            validMoves: this.gameStarted ? this.getValidMoves(this.currentPlayer) : []
        };
    }

    getScores() {
        let player1Score = 0;
        let player2Score = 0;

        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if (this.board[row][col] === 1) player1Score++;
                if (this.board[row][col] === 2) player2Score++;
            }
        }

        return { player1Score, player2Score };
    }

    getValidMoves(player) {
        const validMoves = [];
        const directions = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ];

        for (let row = 0; row < 8; row++) {
            for (let col = 0; col < 8; col++) {
                if (this.board[row][col] === 0) {
                    for (let [dx, dy] of directions) {
                        if (this.isValidDirection(row, col, dx, dy, player)) {
                            validMoves.push({ row, col });
                            break;
                        }
                    }
                }
            }
        }

        return validMoves;
    }

    isValidDirection(row, col, dx, dy, player) {
        let x = row + dx;
        let y = col + dy;
        let hasOpponent = false;

        while (x >= 0 && x < 8 && y >= 0 && y < 8) {
            if (this.board[x][y] === 0) {
                return false;
            }
            if (this.board[x][y] === player) {
                return hasOpponent;
            }
            hasOpponent = true;
            x += dx;
            y += dy;
        }

        return false;
    }

    makeMove(row, col, playerId) {
        if (this.gameOver || !this.gameStarted) {
            return { success: false, error: 'Game not active' };
        }

        const player = this.players.find(p => p.id === playerId);
        if (!player || player.playerNumber !== this.currentPlayer) {
            return { success: false, error: 'Not your turn' };
        }

        if (this.board[row][col] !== 0) {
            return { success: false, error: 'Cell occupied' };
        }

        const validMoves = this.getValidMoves(this.currentPlayer);
        const isValid = validMoves.some(move => move.row === row && move.col === col);

        if (!isValid) {
            return { success: false, error: 'Invalid move' };
        }

        // Make move
        this.board[row][col] = this.currentPlayer;
        const flippedPieces = this.flipPieces(row, col, this.currentPlayer);

        // Switch player
        this.switchPlayer();

        // Check game over
        this.checkGameOver();

        this.lastActivity = Date.now();

        return { 
            success: true, 
            flippedPieces,
            gameState: this.getGameState()
        };
    }

    flipPieces(row, col, player) {
        const directions = [
            [-1, -1], [-1, 0], [-1, 1],
            [0, -1],           [0, 1],
            [1, -1],  [1, 0],  [1, 1]
        ];

        const toFlip = [];

        for (let [dx, dy] of directions) {
            const piecesToFlip = [];
            let x = row + dx;
            let y = col + dy;

            while (x >= 0 && x < 8 && y >= 0 && y < 8) {
                if (this.board[x][y] === 0) {
                    break;
                }
                if (this.board[x][y] === player) {
                    toFlip.push(...piecesToFlip);
                    break;
                }
                piecesToFlip.push({ x, y });
                x += dx;
                y += dy;
            }
        }

        // Flip pieces
        toFlip.forEach(({ x, y }) => {
            this.board[x][y] = player;
        });

        return toFlip;
    }

    switchPlayer() {
        const nextPlayer = this.currentPlayer === 1 ? 2 : 1;
        const validMoves = this.getValidMoves(nextPlayer);

        if (validMoves.length > 0) {
            this.currentPlayer = nextPlayer;
        } else {
            const currentValidMoves = this.getValidMoves(this.currentPlayer);
            if (currentValidMoves.length === 0) {
                this.endGame();
                return;
            }
        }
    }

    checkGameOver() {
        const { player1Score, player2Score } = this.getScores();
        const totalPieces = player1Score + player2Score;

        if (totalPieces === 64) {
            this.endGame();
            return;
        }

        const player1Moves = this.getValidMoves(1);
        const player2Moves = this.getValidMoves(2);

        if (player1Moves.length === 0 && player2Moves.length === 0) {
            this.endGame();
        }
    }

    endGame() {
        this.gameOver = true;
        const { player1Score, player2Score } = this.getScores();
        
        if (player1Score > player2Score) {
            this.winner = 1;
        } else if (player2Score > player1Score) {
            this.winner = 2;
        } else {
            this.winner = 0; // Draw
        }
    }

    updatePlayerEmoji(playerId, emoji) {
        const player = this.players.find(p => p.id === playerId);
        if (player) {
            player.emoji = emoji;
            return true;
        }
        return false;
    }

    resetGame() {
        this.board = Array(8).fill().map(() => Array(8).fill(0));
        this.board[3][3] = 2;
        this.board[3][4] = 1;
        this.board[4][3] = 1;
        this.board[4][4] = 2;
        this.currentPlayer = 1;
        this.gameOver = false;
        this.winner = null;
        this.lastActivity = Date.now();
    }
}

// Socket.IO connection handling
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Create room
    socket.on('createRoom', (data) => {
        const { playerName } = data;
        const roomId = generateRoomId();
        const room = new GameRoom(roomId, socket.id, playerName);
        
        rooms.set(roomId, room);
        players.set(socket.id, { roomId, playerName });
        
        socket.join(roomId);
        
        socket.emit('roomCreated', {
            roomId,
            gameState: room.getGameState()
        });
        
        console.log(`Room created: ${roomId} by ${playerName}`);
    });

    // Join room
    socket.on('joinRoom', (data) => {
        const { roomId, playerName } = data;
        const room = rooms.get(roomId);
        
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        if (room.players.length >= 2) {
            socket.emit('error', { message: 'Room is full' });
            return;
        }
        
        const success = room.addPlayer(socket.id, playerName);
        if (success) {
            players.set(socket.id, { roomId, playerName });
            socket.join(roomId);
            
            io.to(roomId).emit('playerJoined', {
                gameState: room.getGameState()
            });
            
            console.log(`${playerName} joined room ${roomId}`);
        } else {
            socket.emit('error', { message: 'Cannot join room' });
        }
    });

    // Make move
    socket.on('makeMove', (data) => {
        const { row, col } = data;
        const playerData = players.get(socket.id);
        
        if (!playerData) {
            socket.emit('error', { message: 'Player not in any room' });
            return;
        }
        
        const room = rooms.get(playerData.roomId);
        if (!room) {
            socket.emit('error', { message: 'Room not found' });
            return;
        }
        
        const result = room.makeMove(row, col, socket.id);
        
        if (result.success) {
            io.to(playerData.roomId).emit('moveMade', {
                row,
                col,
                player: room.currentPlayer === 1 ? 2 : 1, // Previous player
                flippedPieces: result.flippedPieces,
                gameState: result.gameState
            });
        } else {
            socket.emit('error', { message: result.error });
        }
    });

    // Update emoji
    socket.on('updateEmoji', (data) => {
        const { emoji } = data;
        const playerData = players.get(socket.id);
        
        if (!playerData) return;
        
        const room = rooms.get(playerData.roomId);
        if (!room) return;
        
        if (room.updatePlayerEmoji(socket.id, emoji)) {
            io.to(playerData.roomId).emit('emojiUpdated', {
                playerId: socket.id,
                emoji,
                gameState: room.getGameState()
            });
        }
    });

    // Reset game
    socket.on('resetGame', () => {
        const playerData = players.get(socket.id);
        if (!playerData) return;
        
        const room = rooms.get(playerData.roomId);
        if (!room) return;
        
        room.resetGame();
        io.to(playerData.roomId).emit('gameReset', {
            gameState: room.getGameState()
        });
    });

    // Get game state
    socket.on('getGameState', () => {
        const playerData = players.get(socket.id);
        if (!playerData) return;
        
        const room = rooms.get(playerData.roomId);
        if (!room) return;
        
        socket.emit('gameState', room.getGameState());
    });

    // Handle disconnection
    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        
        const playerData = players.get(socket.id);
        if (playerData) {
            const room = rooms.get(playerData.roomId);
            if (room) {
                room.removePlayer(socket.id);
                
                // Notify other players
                socket.to(playerData.roomId).emit('playerDisconnected', {
                    playerId: socket.id,
                    gameState: room.getGameState()
                });
                
                // Clean up empty rooms after 5 minutes
                setTimeout(() => {
                    if (room.players.every(p => !p.connected)) {
                        rooms.delete(playerData.roomId);
                        console.log(`Room ${playerData.roomId} cleaned up`);
                    }
                }, 5 * 60 * 1000);
            }
            
            players.delete(socket.id);
        }
    });

    // Reconnect to room
    socket.on('reconnect', (data) => {
        const { roomId, playerName } = data;
        const room = rooms.get(roomId);
        
        if (room && room.reconnectPlayer(socket.id)) {
            players.set(socket.id, { roomId, playerName });
            socket.join(roomId);
            
            socket.emit('reconnected', {
                gameState: room.getGameState()
            });
            
            socket.to(roomId).emit('playerReconnected', {
                playerId: socket.id,
                gameState: room.getGameState()
            });
        } else {
            socket.emit('error', { message: 'Cannot reconnect to room' });
        }
    });
});

// REST API endpoints
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/api/rooms', (req, res) => {
    const roomList = Array.from(rooms.values()).map(room => ({
        id: room.id,
        players: room.players.length,
        gameStarted: room.gameStarted,
        lastActivity: room.lastActivity
    }));
    
    res.json(roomList);
});

app.get('/api/room/:roomId', (req, res) => {
    const room = rooms.get(req.params.roomId);
    if (room) {
        res.json(room.getGameState());
    } else {
        res.status(404).json({ error: 'Room not found' });
    }
});

// Clean up inactive rooms every hour
setInterval(() => {
    const now = Date.now();
    const INACTIVE_TIMEOUT = 60 * 60 * 1000; // 1 hour
    
    for (const [roomId, room] of rooms.entries()) {
        if (now - room.lastActivity > INACTIVE_TIMEOUT) {
            rooms.delete(roomId);
            console.log(`Cleaned up inactive room: ${roomId}`);
        }
    }
}, 60 * 60 * 1000);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`🚀 Othello server running on port ${PORT}`);
    console.log(`🌐 Open http://localhost:${PORT} to play`);
});
module.exports = { app, server, io };
