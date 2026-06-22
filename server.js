const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');

const app = express();
app.use(cors());

const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: "*", methods: ["GET", "POST"] }
});

const rooms = {};

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

function checkWinPattern(hand) {
    if (hand.length !== 8) return false;
    let sortedHand = [...hand].sort();
    return canDecompose(sortedHand, false);
}

function canDecompose(cards, hasEye) {
    if (cards.length === 0) return hasEye;
    if (!hasEye) {
        for (let i = 0; i < cards.length - 1; i++) {
            if (cards[i] === cards[i+1]) {
                let remaining = [...cards];
                remaining.splice(i, 2);
                if (canDecompose(remaining, true)) return true;
            }
        }
    }
    let c1 = cards[0];
    if (cards.filter(c => c === c1).length >= 3) {
        let remaining = [...cards];
        remaining.splice(0, 3);
        if (canDecompose(remaining, hasEye)) return true;
    }
    if (c1 === '將' || c1 === '士' || c1 === '象') {
        if (cards.includes('將') && cards.includes('士') && cards.includes('象')) {
            let remaining = [...cards];
            remaining.splice(remaining.indexOf('將'), 1);
            remaining.splice(remaining.indexOf('士'), 1);
            remaining.splice(remaining.indexOf('象'), 1);
            if (canDecompose(remaining, hasEye)) return true;
        }
    }
    if (c1 === '帥' || c1 === '仕' || c1 === '相') {
        if (cards.includes('帥') && cards.includes('仕') && cards.includes('相')) {
            let remaining = [...cards];
            remaining.splice(remaining.indexOf('帥'), 1);
            remaining.splice(remaining.indexOf('仕'), 1);
            remaining.splice(remaining.indexOf('相'), 1);
            if (canDecompose(remaining, hasEye)) return true;
        }
    }
    if (c1 === '車' || c1 === '馬' || c1 === '包' || c1 === '炮') {
        if (cards.includes('車') && cards.includes('馬') && cards.includes('包')) {
            let remaining = [...cards];
            remaining.splice(remaining.indexOf('車'), 1);
            remaining.splice(remaining.indexOf('馬'), 1);
            remaining.splice(remaining.indexOf('包'), 1);
            if (canDecompose(remaining, hasEye)) return true;
        }
        if (cards.includes('車') && cards.includes('馬') && cards.includes('炮')) {
            let remaining = [...cards];
            remaining.splice(remaining.indexOf('車'), 1);
            remaining.splice(remaining.indexOf('馬'), 1);
            remaining.splice(remaining.indexOf('炮'), 1);
            if (canDecompose(remaining, hasEye)) return true;
        }
    }
    return false;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ username, roomCode }) => {
        if (!roomCode || !username) return;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = { players: [], deck: [], turn: 0, pool: [], status: 'waiting', lastPlayed: null, pendingActions: {}, disconnectTimeouts: {} };
        }

        const room = rooms[roomCode];
        
        // 【優化】檢查是否是斷線重連的玩家
        const existingPlayer = room.players.find(p => p.name === username);
        if (existingPlayer) {
            existingPlayer.id = socket.id; // 更新連線 ID
            if (room.disconnectTimeouts[username]) {
                clearTimeout(room.disconnectTimeouts[username]);
                delete room.disconnectTimeouts[username];
            }
            console.log(`玩家 ${username} 成功重連回房間 ${roomCode}`);
            if (room.status === 'playing') {
                sendStateToAll(roomCode);
            } else {
                io.to(roomCode).emit('roomUpdated', room.players.map(p => p.name));
            }
            return;
        }

        if (room.status === 'playing') {
            socket.emit('errorMessage', '遊戲已經在進行中，無法中途加入！');
            return;
        }

        if (room.players.length >= 4) {
            socket.emit('errorMessage', '該房間人數已滿 4 人！');
            return;
        }

        room.players.push({ id: socket.id, name: username, hand: [] });
        io.to(roomCode).emit('roomUpdated', room.players.map(p => p.name));

        if (room.players.length === 4) {
            room.status = 'playing';
            room.deck = shuffleDeck();
            room.pool = [];
            room.turn = 0;

            for (let i = 0; i < 4; i++) {
                room.players[i].hand = room.deck.splice(0, 7);
            }
            room.players[0].hand.push(room.deck.splice(0, 1)[0]);

            sendStateToAll(roomCode);
        }
    });

    socket.on('playCard', ({ roomCode, cardIndex }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing' || room.turn !== room.players.findIndex(p => p.id === socket.id)) return;

        const player = room.players[room.turn];
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        room.lastPlayed = { card: playedCard, playerIndex: room.turn };
        room.pool.push(playedCard);

        room.pendingActions = {};
        let hasInterception = false;

        room.players.forEach((p, idx) => {
            if (idx === room.turn) return;

            let canPong = p.hand.filter(c => c === playedCard).length >= 2;
            let tempHand = [...p.hand, playedCard];
            let canWin = checkWinPattern(tempHand);

            if (canPong || canWin) {
                hasInterception = true;
                room.pendingActions[p.id] = { canPong, canWin, decided: false, action: null };
                io.to(p.id).emit('askInterception', { card: playedCard, canPong, canWin });
            }
        });

        if (hasInterception) {
            sendStateToAll(roomCode, true); 
        } else {
            nextTurn(roomCode);
        }
    });

    socket.on('respondInterception', ({ roomCode, action }) => {
        const room = rooms[roomCode];
        if (!room || !room.pendingActions[socket.id]) return;

        room.pendingActions[socket.id].decided = true;
        room.pendingActions[socket.id].action = action;

        let allDecided = Object.values(room.pendingActions).every(a => a.decided);
        if (allDecided) {
            let winPlayerId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'win');
            let pongPlayerId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'pong');

            if (winPlayerId) {
                const winner = room.players.find(p => p.id === winPlayerId);
                io.to(roomCode).emit('gameOver', { winner: winner.name, reason: `胡了別人打的「${room.lastPlayed.card}」！🎉` });
                delete rooms[roomCode];
            } else if (pongPlayerId) {
                const pIdx = room.players.findIndex(p => p.id === pongPlayerId);
                const player = room.players[pIdx];
                room.pool.pop();
                player.hand.push(room.lastPlayed.card);
                room.turn = pIdx;
                room.lastPlayed = null;
                room.pendingActions = {};
                sendStateToAll(roomCode);
            } else {
                nextTurn(roomCode);
            }
        }
    });

    socket.on('claimWin', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.turn) return;

        const player = room.players[pIdx];
        if (checkWinPattern(player.hand)) {
            io.to(roomCode).emit('gameOver', { winner: player.name, reason: '自摸胡牌！驗證成功！🎉' });
            delete rooms[roomCode];
        } else {
            socket.emit('errorMessage', '詐胡！牌型不符合胡牌規則喔！');
        }
    });

    function nextTurn(roomCode) {
        const room = rooms[roomCode];
        if (room.deck.length === 0) {
            io.to(roomCode).emit('gameOver', { winner: '流局', reason: '牌組已摸完！' });
            delete rooms[roomCode];
            return;
        }
        room.turn = (room.turn + 1) % 4;
        room.players[room.turn].hand.push(room.deck.splice(0, 1)[0]);
        room.lastPlayed = null;
        room.pendingActions = {};
        sendStateToAll(roomCode);
    }

    function sendStateToAll(roomCode, isWaitingAction = false) {
        const room = rooms[roomCode];
        room.players.forEach((player, index) => {
            io.to(player.id).emit('gameStateUpdated', {
                myHand: player.hand,
                playerNames: room.players.map(p => p.name),
                turnIndex: room.turn,
                myIndex: index,
                deckCount: room.deck.length,
                isMyTurn: index === room.turn && !isWaitingAction,
                pool: room.pool,
                lastPlayed: room.lastPlayed
            });
        });
    }

    // 【優化】斷線給予 15 秒寬限時間重連
    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const p = room.players.find(player => player.id === socket.id);
            if (p) {
                console.log(`玩家 ${p.name} 暫時中斷連線，等待重連...`);
                // 15 秒內如果沒有重連回來，才正式結束遊戲
                room.disconnectTimeouts[p.name] = setTimeout(() => {
                    io.to(roomCode).emit('errorMessage', `玩家 ${p.name} 斷線超時，遊戲結束。`);
                    delete rooms[roomCode];
                }, 15000);
                break;
            }
        }
    });
});

server.listen(process.env.PORT || 3000);
