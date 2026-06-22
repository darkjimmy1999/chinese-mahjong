const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: {
        origin: "*", 
        methods: ["GET", "POST"]
    }
});

const rooms = {};
const ORIGINAL_DECK = [
    '帥', '仕', '仕', '相', '相', '車', '車', '馬', '馬', '炮', '炮', '兵', '兵', '兵', '兵', '兵',
    '將', '士', '士', '象', '象', '車', '車', '馬', '馬', '包', '包', '卒', '卒', '卒', '卒', '卒'
];

function shuffleDeck() {
    let deck = [...ORIGINAL_DECK];
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

io.on('connection', (socket) => {
    console.log(`玩家連線: ${socket.id}`);

    socket.on('joinRoom', ({ username, roomCode }) => {
        if (!roomCode || !username) return;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = {
                players: [],
                deck: [],
                turn: 0,
                pool: [],
                status: 'waiting'
            };
        }

        const room = rooms[roomCode];
        if (room.players.length >= 2) {
            socket.emit('errorMessage', '該房間人數已滿！');
            return;
        }

        room.players.push({ id: socket.id, name: username, hand: [] });
        io.to(roomCode).emit('roomUpdated', room.players.map(p => p.name));

        if (room.players.length === 2) {
            room.status = 'playing';
            room.deck = shuffleDeck();
            room.pool = [];
            room.turn = 0;

            room.players[0].hand = room.deck.splice(0, 5);
            room.players[1].hand = room.deck.splice(0, 5);
            room.players[0].hand.push(room.deck.splice(0, 1)[0]);

            room.players.forEach((player, index) => {
                const opponent = room.players[(index + 1) % 2];
                io.to(player.id).emit('gameStart', {
                    myHand: player.hand,
                    opponentName: opponent.name,
                    opponentHandCount: opponent.hand.length,
                    deckCount: room.deck.length,
                    isMyTurn: index === room.turn,
                    pool: room.pool
                });
            });
        }
    });

    socket.on('playCard', ({ roomCode, cardIndex }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const playerIndex = room.players.findIndex(p => p.id === socket.id);
        if (playerIndex !== room.turn) return;

        const player = room.players[playerIndex];
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        room.pool.push(playedCard);

        if (room.deck.length === 0) {
            io.to(roomCode).emit('gameOver', { winner: '流局', reason: '牌組已摸完！' });
            delete rooms[roomCode];
            return;
        }

        room.turn = (room.turn + 1) % 2;
        const nextPlayer = room.players[room.turn];
        const drawnCard = room.deck.splice(0, 1)[0];
        nextPlayer.hand.push(drawnCard);

        room.players.forEach((p, idx) => {
            const opp = room.players[(idx + 1) % 2];
            io.to(p.id).emit('gameStateUpdated', {
                myHand: p.hand,
                opponentHandCount: opp.hand.length,
                deckCount: room.deck.length,
                isMyTurn: idx === room.turn,
                pool: room.pool
            });
        });
    });

    socket.on('claimWin', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const player = room.players.find(p => p.id === socket.id);
        io.to(roomCode).emit('gameOver', { winner: player.name, reason: '胡牌了！' });
        delete rooms[roomCode];
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                io.to(roomCode).emit('errorMessage', '對手已中途離開遊戲。');
                delete rooms[roomCode];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`象棋麻將伺服器運行中`));
