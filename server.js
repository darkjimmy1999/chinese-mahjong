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

// 4人玩改用完整兩組象棋（共 64 張牌），牌數才夠
const BASE_DECK = [
    '帥', '仕', '仕', '相', '相', '車', '車', '馬', '馬', '炮', '炮', '兵', '兵', '兵', '兵', '兵',
    '將', '士', '士', '象', '象', '車', '車', '馬', '馬', '包', '包', '卒', '卒', '卒', '卒', '卒'
];
const ORIGINAL_DECK = [...BASE_DECK, ...BASE_DECK]; 

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
        
        // 規則修改：改成上限 4 人
        if (room.players.length >= 4) {
            socket.emit('errorMessage', '該房間人數已滿 4 人！');
            return;
        }

        room.players.push({ id: socket.id, name: username, hand: [] });
        io.to(roomCode).emit('roomUpdated', room.players.map(p => p.name));

        // 滿 4 人自動開局
        if (room.players.length === 4) {
            room.status = 'playing';
            room.deck = shuffleDeck();
            room.pool = [];
            room.turn = 0; // 第一個加入的人當莊家先出牌

            // 發牌規則修改：每人發 7 張手牌
            for (let i = 0; i < 4; i++) {
                room.players[i].hand = room.deck.splice(0, 7);
            }
            // 莊家（第 0 位）多摸第 8 張牌，準備直接出牌
            room.players[0].hand.push(room.deck.splice(0, 1)[0]);

            // 通知所有人遊戲開始
            room.players.forEach((player, index) => {
                io.to(player.id).emit('gameStart', {
                    myHand: player.hand,
                    playerNames: room.players.map(p => p.name),
                    myIndex: index,
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

        // 順時針輪到下一位玩家 (0 -> 1 -> 2 -> 3 -> 0)
        room.turn = (room.turn + 1) % 4;
        const nextPlayer = room.players[room.turn];
        
        // 下一位玩家摸第 8 張牌
        const drawnCard = room.deck.splice(0, 1)[0];
        nextPlayer.hand.push(drawnCard);

        // 更新所有人的畫面
        room.players.forEach((p, idx) => {
            io.to(p.id).emit('gameStateUpdated', {
                myHand: p.hand,
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
        io.to(roomCode).emit('gameOver', { winner: player.name, reason: '成功胡牌囉！' });
        delete rooms[roomCode];
    });

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const pIdx = room.players.findIndex(p => p.id === socket.id);
            if (pIdx !== -1) {
                io.to(roomCode).emit('errorMessage', `玩家 ${room.players[pIdx].name} 離開了，遊戲結束。`);
                delete rooms[roomCode];
                break;
            }
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`4人象棋麻將伺服器運行中`));
