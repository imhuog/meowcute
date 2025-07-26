// ==================================
// SERVER.JS - Enhanced Backend Server
// ==================================
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const path = require('path');
const cors = require('cors');
const helmet = require('helmet');
const compression = require('compression');
const fs = require('fs').promises; // Sử dụng fs.promises cho các hàm bất đồng bộ

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*", // Cho phép tất cả các nguồn truy cập (có thể thay đổi thành miền cụ thể của bạn)
        methods: ["GET", "POST"]
    }
});

// Middleware  
app.use(helmet({
    contentSecurityPolicy: false, // Bạn có thể muốn cấu hình CSP cụ thể hơn
    crossOriginEmbedderPolicy: false
}));
app.use(compression()); // Nén phản hồi HTTP
app.use(cors()); // Cho phép Cross-Origin Resource Sharing
app.use(express.json()); // Phân tích các yêu cầu JSON
app.use(express.static(path.join(__dirname, 'public'))); // Phục vụ các tệp tĩnh từ thư mục 'public'

// Game rooms storage
// rooms: Map<roomId, GameRoom instance>
// players: Map<socket.id, { roomId, playerName }>
// leaderboard: Map<playerName, { name, rating, wins, losses }>
// gameStats: Map<playerName, { name, totalGames, wins, losses, ties, pointsScored, pointsConceded }
const rooms = new Map();
const players = new Map(); // Maps socket.id to { roomId, playerName, playerColor }
const leaderboard = new Map();
const gameStats = new Map();

// File paths for persistence
const LEADERBOARD_FILE = path.join(__dirname, 'data', 'leaderboard.json');
const STATS_FILE = path.join(__dirname, 'data', 'stats.json');

// Initialize data directory
async function initializeDataDirectory() {
    try {
        await fs.mkdir(path.join(__dirname, 'data'), { recursive: true });
        console.log('Data directory ensured.');
        await loadLeaderboard();
        await loadStats();
    } catch (error) {
        console.error('Error initializing data directory:', error);
    }
}

// Leaderboard management
async function loadLeaderboard() {
    try {
        const data = await fs.readFile(LEADERBOARD_FILE, 'utf8');
        const parsed = JSON.parse(data);
        leaderboard.clear(); // Clear existing data before loading
        parsed.forEach(entry => leaderboard.set(entry.name, entry));
        console.log('Leaderboard loaded.');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('Leaderboard file not found, starting fresh.');
        } else {
            console.error('Error loading leaderboard:', error);
        }
    }
}

async function saveLeaderboard() {
    try {
        const data = JSON.stringify(Array.from(leaderboard.values()), null, 2);
        await fs.writeFile(LEADERBOARD_FILE, data, 'utf8');
        console.log('Leaderboard saved.');
    } catch (error) {
        console.error('Error saving leaderboard:', error);
    }
}

// Game stats management
async function loadStats() {
    try {
        const data = await fs.readFile(STATS_FILE, 'utf8');
        const parsed = JSON.parse(data);
        gameStats.clear(); // Clear existing data before loading
        parsed.forEach(entry => gameStats.set(entry.name, entry));
        console.log('Game stats loaded.');
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log('Game stats file not found, starting fresh.');
        } else {
            console.error('Error loading game stats:', error);
        }
    }
}

async function saveStats() {
    try {
        const data = JSON.stringify(Array.from(gameStats.values()), null, 2);
        await fs.writeFile(STATS_FILE, data, 'utf8');
        console.log('Game stats saved.');
    } catch (error) {
        console.error('Error saving game stats:', error);
    }
}

function updateLeaderboardRating(playerName, result) {
    let player = leaderboard.get(playerName) || { name: playerName, rating: 1000, wins: 0, losses: 0 };

    if (result === 'win') {
        player.rating += 15; // Tăng điểm khi thắng
        player.wins += 1;
    } else if (result === 'loss') {
        player.rating = Math.max(100, player.rating - 10); // Giảm điểm khi thua, không dưới 100
        player.losses += 1;
    }
    leaderboard.set(playerName, player);
    saveLeaderboard();
}

function updatePlayerStats(playerName, result, pointsScored = 0, pointsConceded = 0) {
    let stats = gameStats.get(playerName) || { name: playerName, totalGames: 0, wins: 0, losses: 0, ties: 0, pointsScored: 0, pointsConceded: 0 };
    stats.totalGames += 1;

    if (result === 'win') {
        stats.wins += 1;
        stats.pointsScored += pointsScored;
        stats.pointsConceded += pointsConceded;
    } else if (result === 'loss') {
        stats.losses += 1;
        stats.pointsScored += pointsScored;
        stats.pointsConceded += pointsConceded;
    } else if (result === 'tie') {
        stats.ties += 1;
        stats.pointsScored += pointsScored;
        stats.pointsConceded += pointsConceded;
    }
    gameStats.set(playerName, stats);
    saveStats();
}

// Helper to generate unique room ID
function generateRoomId() {
    let id;
    do {
        id = Math.random().toString(36).substring(2, 8).toUpperCase();
    } while (rooms.has(id));
    return id;
}

// Helper to get room list for display
function getRoomList() {
    return Array.from(rooms.values())
        .filter(room => room.gameMode === 'online' && room.players.length < 2 && !room.gameStarted)
        .map(room => ({
            id: room.id,
            name: room.id, // Mặc định hiển thị ID, có thể dùng tên người tạo nếu muốn
            players: room.players.length,
            lastActivity: room.lastActivity
        }));
}

// GameRoom Class (Defined inline for completeness)
class GameRoom {
    constructor(id, hostSocketId, hostName, mode = 'online') {
        this.id = id;
        this.gameMode = mode;
        this.board = Array(8).fill(0).map(() => Array(8).fill(0));
        this.currentPlayer = 1; // 1 for Black, 2 for White
        this.players = [
            { id: hostSocketId, name: hostName, color: 1, connected: true }, // Host is always black (1)
        ];
        this.spectators = [];
        this.gameStarted = false;
        this.gameOver = false;
        this.winner = null;
        this.scores = { 1: 0, 2: 0 };
        this.lastActivity = Date.now();
        this.chatMessages = [];
        this.initializeBoard();
    }

    initializeBoard() {
        this.board = Array(8).fill(0).map(() => Array(8).fill(0));
        this.board[3][3] = 2; // White
        this.board[3][4] = 1; // Black
        this.board[4][3] = 1; // Black
        this.board[4][4] = 2; // White
        this.updateScores();
    }

    addPlayer(socketId, playerName) {
        if (this.players.length < 2) {
            const playerColor = this.players.length === 0 ? 1 : 2; // If host disconnects, first to join gets host color
            this.players.push({ id: socketId, name: playerName, color: playerColor, connected: true });
            this.lastActivity = Date.now();
            return true;
        }
        return false;
    }

    removePlayer(socketId) {
        const playerIndex = this.players.findIndex(p => p.id === socketId);
        if (playerIndex !== -1) {
            const disconnectedPlayer = this.players[playerIndex];
            disconnectedPlayer.connected = false; // Mark as disconnected
            console.log(`Player ${disconnectedPlayer.name} disconnected from room ${this.id}`);
            // If both players are disconnected, consider closing the room after timeout
            this.lastActivity = Date.now();
            return { disconnectedPlayer: disconnectedPlayer, roomEmpty: this.players.every(p => !p.connected) && this.spectators.length === 0 };
        }
        const spectatorIndex = this.spectators.findIndex(s => s.id === socketId);
        if (spectatorIndex !== -1) {
            this.spectators.splice(spectatorIndex, 1);
            console.log(`Spectator ${socketId} left room ${this.id}`);
            this.lastActivity = Date.now();
            return { disconnectedPlayer: null, roomEmpty: this.players.every(p => !p.connected) && this.spectators.length === 0 };
        }
        return { disconnectedPlayer: null, roomEmpty: false };
    }

    reconnectPlayer(socketId, playerName) {
        const player = this.players.find(p => p.name === playerName);
        if (player) {
            player.id = socketId; // Update socket ID
            player.connected = true;
            this.lastActivity = Date.now();
            return true;
        }
        return false;
    }

    addSpectator(socketId, spectatorName) {
        this.spectators.push({ id: socketId, name: spectatorName });
        this.lastActivity = Date.now();
    }

    startGame() {
        if (this.players.length === 2 && !this.gameStarted) {
            this.gameStarted = true;
            this.lastActivity = Date.now();
            console.log(`Game started in room ${this.id}`);
            return true;
        }
        return false;
    }

    // Othello game logic
    getValidMoves(playerColor) {
        const validMoves = [];
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (this.board[r][c] === 0 && this.isValidMove(r, c, playerColor)) {
                    validMoves.push({ r, c });
                }
            }
        }
        return validMoves;
    }

    isValidMove(r, c, playerColor) {
        if (this.board[r][c] !== 0) return false;

        const opponentColor = playerColor === 1 ? 2 : 1;
        const directions = [
            [-1, 0], [1, 0], [0, -1], [0, 1], // Cardinal
            [-1, -1], [-1, 1], [1, -1], [1, 1]  // Diagonal
        ];

        for (const [dr, dc] of directions) {
            let foundOpponent = false;
            let currentR = r + dr;
            let currentC = c + dc;

            while (currentR >= 0 && currentR < 8 && currentC >= 0 && currentC < 8) {
                if (this.board[currentR][currentC] === opponentColor) {
                    foundOpponent = true;
                } else if (this.board[currentR][currentC] === playerColor && foundOpponent) {
                    return true; // Found opponent pieces and then own piece
                } else {
                    break; // Empty cell or own piece without finding opponent first
                }
                currentR += dr;
                currentC += dc;
            }
        }
        return false;
    }

    makeMove(r, c, playerColor) {
        if (!this.isValidMove(r, c, playerColor)) {
            return { success: false, message: "Nước đi không hợp lệ." };
        }

        const flippedPieces = [];
        this.board[r][c] = playerColor; // Place the new piece

        const opponentColor = playerColor === 1 ? 2 : 1;
        const directions = [
            [-1, 0], [1, 0], [0, -1], [0, 1],
            [-1, -1], [-1, 1], [1, -1], [1, 1]
        ];

        for (const [dr, dc] of directions) {
            let lineToFlip = [];
            let currentR = r + dr;
            let currentC = c + dc;
            while (currentR >= 0 && currentR < 8 && currentC >= 0 && currentC < 8) {
                if (this.board[currentR][currentC] === opponentColor) {
                    lineToFlip.push({ r: currentR, c: currentC });
                } else if (this.board[currentR][currentC] === playerColor) {
                    // Found own piece, flip everything in lineToFlip
                    for (const { r: flipR, c: flipC } of lineToFlip) {
                        this.board[flipR][flipC] = playerColor;
                        flippedPieces.push({ r: flipR, c: flipC }); // Track flipped pieces
                    }
                    break;
                } else {
                    // Empty cell
                    break;
                }
                currentR += dr;
                currentC += dc;
            }
        }
        this.updateScores();
        this.lastActivity = Date.now();
        return { success: true, flippedPieces: flippedPieces };
    }

    updateScores() {
        let blackCount = 0;
        let whiteCount = 0;
        for (let r = 0; r < 8; r++) {
            for (let c = 0; c < 8; c++) {
                if (this.board[r][c] === 1) blackCount++;
                else if (this.board[r][c] === 2) whiteCount++;
            }
        }
        this.scores[1] = blackCount;
        this.scores[2] = whiteCount;
    }

    switchTurn() {
        this.currentPlayer = this.currentPlayer === 1 ? 2 : 1;
        const validMoves = this.getValidMoves(this.currentPlayer);
        if (validMoves.length === 0) {
            console.log(`Player ${this.currentPlayer} has no valid moves. Skipping turn.`);
            this.currentPlayer = this.currentPlayer === 1 ? 2 : 1; // Switch back to other player
            const otherPlayerMoves = this.getValidMoves(this.currentPlayer);
            if (otherPlayerMoves.length === 0) {
                this.gameOver = true; // No moves for either player
            }
        }
        this.lastActivity = Date.now();
    }

    checkGameOver() {
        const movesPlayer1 = this.getValidMoves(1).length;
        const movesPlayer2 = this.getValidMoves(2).length;

        if (movesPlayer1 === 0 && movesPlayer2 === 0 || (this.scores[1] + this.scores[2] === 64)) {
            this.gameOver = true;
            return true;
        }
        return false;
    }

    getGameResult() {
        if (!this.gameOver) return null;

        if (this.scores[1] > this.scores[2]) {
            return { winnerColor: 1, scores: this.scores };
        } else if (this.scores[2] > this.scores[1]) {
            return { winnerColor: 2, scores: this.scores };
        } else {
            return { winnerColor: 0, scores: this.scores }; // 0 for tie
        }
    }

    resetGame() {
        this.initializeBoard();
        this.currentPlayer = 1;
        this.gameStarted = true;
        this.gameOver = false;
        this.winner = null;
        this.chatMessages = [];
        this.lastActivity = Date.now();
    }
}

// Socket.IO event handlers
io.on('connection', (socket) => {
    console.log('New client connected:', socket.id);

    socket.on('createRoom', (playerName) => {
        const roomId = generateRoomId();
        const room = new GameRoom(roomId, socket.id, playerName);
        rooms.set(roomId, room);
        players.set(socket.id, { roomId: roomId, playerName: playerName, playerColor: 1 });
        socket.join(roomId);
        console.log(`Room ${roomId} created by ${playerName}`);
        socket.emit('roomCreated', roomId);
        io.emit('updateRoomList', getRoomList()); // Notify all clients of updated room list
    });

    socket.on('joinRoom', (roomId, playerName) => {
        const room = rooms.get(roomId);
        if (!room) {
            socket.emit('roomJoinError', 'Phòng không tồn tại.');
            return;
        }
        if (room.players.length >= 2) {
            // Check if player is rejoining
            const existingPlayer = room.players.find(p => p.name === playerName);
            if (existingPlayer && !existingPlayer.connected) {
                room.reconnectPlayer(socket.id, playerName);
                players.set(socket.id, { roomId: roomId, playerName: playerName, playerColor: existingPlayer.color });
                socket.join(roomId);
                socket.emit('roomJoined', room);
                socket.emit('gameStarted', room); // Re-send game state for reconnected player
                io.to(roomId).emit('playerReconnectedInGame', playerName, existingPlayer.color);
                console.log(`Player ${playerName} reconnected to room ${roomId}`);
                return;
            } else if (existingPlayer && existingPlayer.connected) {
                socket.emit('roomJoinError', 'Người chơi với tên này đã ở trong phòng.');
                return;
            } else {
                // Allow spectating if room is full
                room.addSpectator(socket.id, playerName);
                socket.join(roomId);
                socket.emit('roomJoined', room); // Send room info to spectator
                io.to(roomId).emit('chatMessage', { sender: 'System', message: `${playerName} đã vào phòng với tư cách khán giả.` });
                console.log(`Spectator ${playerName} joined room ${roomId}`);
                return;
            }
        }

        if (room.addPlayer(socket.id, playerName)) {
            const playerInfo = room.players.find(p => p.id === socket.id);
            players.set(socket.id, { roomId: roomId, playerName: playerName, playerColor: playerInfo.color });
            socket.join(roomId);
            socket.emit('roomJoined', room);
            io.to(roomId).emit('playerJoined', room);
            io.emit('updateRoomList', getRoomList());
            console.log(`Player ${playerName} joined room ${roomId}`);
        } else {
            socket.emit('roomJoinError', 'Không thể tham gia phòng này.');
        }
    });

    socket.on('startGame', (roomId) => {
        const room = rooms.get(roomId);
        if (room && room.startGame()) {
            io.to(roomId).emit('gameStarted', room);
            io.emit('updateRoomList', getRoomList());
            console.log(`Game started in room ${roomId}`);
        }
    });

    socket.on('makeMove', (roomId, r, c) => {
        const room = rooms.get(roomId);
        const player = players.get(socket.id);

        if (!room || !player || room.currentPlayer !== player.playerColor || room.gameOver || !room.gameStarted) {
            socket.emit('invalidMove', 'Không phải lượt của bạn hoặc game chưa bắt đầu/đã kết thúc.');
            return;
        }

        const moveResult = room.makeMove(r, c, player.playerColor);

        if (moveResult.success) {
            room.switchTurn();
            io.to(roomId).emit('gameStateUpdate', room);

            if (room.checkGameOver()) {
                const gameResult = room.getGameResult();
                let winnerName = 'Hòa';
                let player1Name = room.players.find(p => p.color === 1)?.name;
                let player2Name = room.players.find(p => p.color === 2)?.name;

                if (gameResult.winnerColor === 1) {
                    winnerName = player1Name;
                    updateLeaderboardRating(player1Name, 'win');
                    updateLeaderboardRating(player2Name, 'loss');
                    updatePlayerStats(player1Name, 'win', room.scores[1], room.scores[2]);
                    updatePlayerStats(player2Name, 'loss', room.scores[2], room.scores[1]);
                } else if (gameResult.winnerColor === 2) {
                    winnerName = player2Name;
                    updateLeaderboardRating(player2Name, 'win');
                    updateLeaderboardRating(player1Name, 'loss');
                    updatePlayerStats(player2Name, 'win', room.scores[2], room.scores[1]);
                    updatePlayerStats(player1Name, 'loss', room.scores[1], room.scores[2]);
                } else {
                    updateLeaderboardRating(player1Name, 'tie');
                    updateLeaderboardRating(player2Name, 'tie');
                    updatePlayerStats(player1Name, 'tie', room.scores[1], room.scores[2]);
                    updatePlayerStats(player2Name, 'tie', room.scores[2], room.scores[1]);
                }
                io.to(roomId).emit('gameEnded', winnerName, room.scores);
                console.log(`Game over in room ${roomId}. Winner: ${winnerName}`);
            }
        } else {
            socket.emit('invalidMove', moveResult.message);
        }
    });

    socket.on('resetGame', (roomId) => {
        const room = rooms.get(roomId);
        if (room) {
            room.resetGame();
            io.to(roomId).emit('gameStateUpdate', room);
            io.to(roomId).emit('chatMessage', { sender: 'System', message: 'Game đã được làm lại!' });
            console.log(`Game reset in room ${roomId}`);
        }
    });

    socket.on('leaveRoom', (roomId) => {
        const room = rooms.get(roomId);
        const playerInfo = players.get(socket.id);
        if (room && playerInfo) {
            const { disconnectedPlayer, roomEmpty } = room.removePlayer(socket.id);
            if (disconnectedPlayer) {
                io.to(roomId).emit('playerLeft', room);
                io.to(roomId).emit('chatMessage', { sender: 'System', message: `${disconnectedPlayer.name} đã rời phòng.` });
                if (roomEmpty) {
                    rooms.delete(roomId);
                    console.log(`Room ${roomId} is empty and deleted.`);
                }
            }
            players.delete(socket.id);
            socket.leave(roomId);
            io.emit('updateRoomList', getRoomList());
            console.log(`Socket ${socket.id} left room ${roomId}`);
        }
    });

    socket.on('leaveGame', (roomId) => {
        const room = rooms.get(roomId);
        const playerInfo = players.get(socket.id);
        if (room && playerInfo) {
            // Mark as disconnected but keep player in room for potential reconnect
            const { disconnectedPlayer, roomEmpty } = room.removePlayer(socket.id);
            if (disconnectedPlayer) {
                io.to(roomId).emit('playerDisconnectedInGame', disconnectedPlayer.name, disconnectedPlayer.color);
                io.to(roomId).emit('chatMessage', { sender: 'System', message: `${disconnectedPlayer.name} đã thoát game.` });
                if (roomEmpty && !room.gameStarted) { // Only delete if room is empty and game hasn't started
                    rooms.delete(roomId);
                    console.log(`Room ${roomId} is empty and deleted after game leave.`);
                }
            }
            players.delete(socket.id);
            socket.leave(roomId);
            io.emit('updateRoomList', getRoomList());
        }
    });


    socket.on('chatMessage', (roomId, message) => {
        const playerInfo = players.get(socket.id);
        const room = rooms.get(roomId);
        if (playerInfo && room) {
            const fullMessage = {
                sender: playerInfo.playerName,
                message: message,
                color: playerInfo.playerColor
            };
            room.chatMessages.push(fullMessage);
            io.to(roomId).emit('chatMessage', fullMessage);
        }
    });

    socket.on('getLeaderboard', () => {
        const sortedLeaderboard = Array.from(leaderboard.values())
            .sort((a, b) => b.rating - a.rating)
            .slice(0, 20); // Top 20
        socket.emit('leaderboardData', sortedLeaderboard);
    });

    socket.on('getPlayerStats', (playerName) => {
        const stats = gameStats.get(playerName);
        socket.emit('playerStatsData', stats || null);
    });

    socket.on('disconnect', () => {
        console.log('Client disconnected:', socket.id);
        const playerInfo = players.get(socket.id);
        if (playerInfo) {
            const room = rooms.get(playerInfo.roomId);
            if (room) {
                const { disconnectedPlayer, roomEmpty } = room.removePlayer(socket.id);
                if (disconnectedPlayer) {
                    if (room.gameStarted) {
                        io.to(room.id).emit('playerDisconnectedInGame', disconnectedPlayer.name, disconnectedPlayer.color);
                        io.to(room.id).emit('chatMessage', { sender: 'System', message: `${disconnectedPlayer.name} đã ngắt kết nối.` });
                    } else {
                        // If game hasn't started and a player leaves, update lobby for others
                        io.to(room.id).emit('playerLeft', room);
                        io.to(room.id).emit('chatMessage', { sender: 'System', message: `${disconnectedPlayer.name} đã rời phòng.` });
                    }

                    if (roomEmpty) {
                        rooms.delete(room.id);
                        console.log(`Room ${room.id} is empty and deleted after disconnect.`);
                    }
                }
            }
            players.delete(socket.id);
            io.emit('updateRoomList', getRoomList());
        }
    });
});

// Get leaderboard data API
app.get('/api/leaderboard', (req, res) => {
    const leaderData = Array.from(leaderboard.values())
        .sort((a, b) => b.rating - a.rating)
        .slice(0, 20); // Top 20
    res.json(leaderData);
});

// Get player stats
app.get('/api/stats/:playerName', (req, res) => {
    const stats = gameStats.get(req.params.playerName);
    if (stats) {
        res.json(stats);
    } else {
        res.status(404).json({ error: 'Player stats not found' });
    }
});

// Clean up inactive rooms (runs periodically)
setInterval(() => {
    const now = Date.now();
    // Thời gian chờ hoạt động: 30 phút (để đủ thời gian cho trận đấu)
    const INACTIVE_TIMEOUT = 30 * 60 * 1000; 
    
    for (const [roomId, room] of rooms.entries()) {
        if (now - room.lastActivity > INACTIVE_TIMEOUT) {
            // Chỉ xóa các phòng không có người chơi nào đang kết nối và không có khán giả
            if (room.players.every(p => !p.connected) && room.spectators.length === 0) {
                rooms.delete(roomId);
                console.log(`Cleaned up inactive room: ${roomId}`);
                io.emit('updateRoomList', getRoomList()); // Cập nhật danh sách phòng
            }
        }
    }
}, 5 * 60 * 1000); // Chạy mỗi 5 phút để kiểm tra

// Start server
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    initializeDataDirectory();
});
