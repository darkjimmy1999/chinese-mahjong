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

// 驗證胡牌：手牌 + 亮牌 總共要有 3+3+2=8 張牌
function checkWinPattern(hand, melds = []) {
    let allCards = [...hand];
    melds.forEach(m => allCards.push(...m.cards));
    if (allCards.length !== 8) return false;
    
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
    // 吃牌組合判定
    const eatGroups = [
        ['將', '士', '象'], ['帥', '仕', '相'],
        ['車', '馬', '包'], ['車', '馬', '炮']
    ];
    for (let group of eatGroups) {
        if (group.includes(c1)) {
            if (cards.includes(group[0]) && cards.includes(group[1]) && cards.includes(group[2])) {
                let remaining = [...cards];
                remaining.splice(remaining.indexOf(group[0]), 1);
                remaining.splice(remaining.indexOf(group[1]), 1);
                remaining.splice(remaining.indexOf(group[2]), 1);
                if (canDecompose(remaining, hasEye)) return true;
            }
        }
    }
    return false;
}

// 檢查是否能吃上家的牌
function getChowChoices(hand, card) {
    const eatGroups = [
        ['將', '士', '象'], ['帥', '仕', '相'],
        ['車', '馬', '包'], ['車', '馬', '炮']
    ];
    let choices = [];
    for (let group of eatGroups) {
        if (group.includes(card)) {
            let needed = group.filter(c => c !== card);
            if (hand.includes(needed[0]) && hand.includes(needed[1])) {
                choices.push(group); 
            }
        }
    }
    return choices;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ username, roomCode }) => {
        if (!roomCode || !username) return;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = { players: [], deck: [], turn: 0, pool: [], status: 'waiting', lastPlayed: null, pendingActions: {}, disconnectTimeouts: {} };
        }

        const room = rooms[roomCode];
        const existingPlayer = room.players.find(p => p.name === username);
        
        if (existingPlayer) {
            existingPlayer.id = socket.id;
            if (room.disconnectTimeouts[username]) clearTimeout(room.disconnectTimeouts[username]);
            if (room.status === 'playing') sendStateToAll(roomCode);
            return;
        }

        if (room.status === 'playing' || room.players.length >= 4) {
            socket.emit('errorMessage', '無法加入該房間！');
            return;
        }

        // melds 欄位用來存放吃碰亮在面前的牌
        room.players.push({ id: socket.id, name: username, hand: [], melds: [] });
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
            let chowChoices = (idx === (room.turn + 1) % 4) ? getChowChoices(p.hand, playedCard) : [];
            let canChow = chowChoices.length > 0;
            let canWin = checkWinPattern([...p.hand, playedCard], p.melds);

            if (canPong || canChow || canWin) {
                hasInterception = true;
                room.pendingActions[p.id] = { canPong, canChow, chowChoices, canWin, decided: false, action: null, details: null };
                io.to(p.id).emit('askInterception', { card: playedCard, canPong, canChow, chowChoices, canWin });
            }
        });

        if (hasInterception) {
            sendStateToAll(roomCode, true); 
        } else {
            nextTurn(roomCode);
        }
    });

    socket.on('respondInterception', ({ roomCode, action, details }) => {
        const room = rooms[roomCode];
        if (!room || !room.pendingActions[socket.id]) return;

        room.pendingActions[socket.id].decided = true;
        room.pendingActions[socket.id].action = action; // 'pong', 'chow', 'win', 'pass'
        room.pendingActions[socket.id].details = details; // 吃的組合

        let allDecided = Object.values(room.pendingActions).every(a => a.decided);
        if (allDecided) {
            let winId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'win');
            let pongId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'pong');
            let chowId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'chow');

            if (winId) {
                const winner = room.players.find(p => p.id === winId);
                io.to(roomCode).emit('gameOver', { winner: winner.name, reason: `胡了別人的「${room.lastPlayed.card}」！🎉` });
                delete rooms[roomCode];
            } else if (pongId) {
                executeMeld(roomCode, pongId, 'pong');
            } else if (chowId) {
                executeMeld(roomCode, chowId, 'chow', room.pendingActions[chowId].details);
            } else {
                nextTurn(roomCode);
            }
        }
    });

    function executeMeld(roomCode, playerId, type, details) {
        const room = rooms[roomCode];
        const pIdx = room.players.findIndex(p => p.id === playerId);
        const player = room.players[pIdx];
        const card = room.lastPlayed.card;

        room.pool.pop(); // 從牌河移除
        
        if (type === 'pong') {
            player.hand.splice(player.hand.indexOf(card), 1);
            player.hand.splice(player.hand.indexOf(card), 1);
            player.melds.push({ type: '碰', cards: [card, card, card] });
        } else if (type === 'chow') {
            // details 格式為 ['將', '士', '象'] 這樣的完整組合
            details.forEach(c => {
                if (c !== card) player.hand.splice(player.hand.indexOf(c), 1);
            });
            player.melds.push({ type: '吃', cards: details });
        }

        room.turn = pIdx; // 回合移給碰/吃的人
        room.lastPlayed = null;
        room.pendingActions = {};
        sendStateToAll(roomCode);
    }

    socket.on('claimWin', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;
        const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.turn) return;

        const player = room.players[pIdx];
        if (checkWinPattern(player.hand, player.melds)) {
            io.to(roomCode).emit('gameOver', { winner: player.name, reason: '自摸胡牌！🎉' });
            delete rooms[roomCode];
        } else {
            socket.emit('errorMessage', '不符合胡牌牌型喔！');
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
            // 整理各家的亮牌狀況與手牌張數傳給前端渲染
            let playersStatus = room.players.map((p, idx) => ({
                name: p.name,
                handCount: p.hand.length,
                melds: p.melds // 吃碰倒在面前的牌
            }));

            io.to(player.id).emit('gameStateUpdated', {
                myHand: player.hand,
                playersStatus: playersStatus,
                turnIndex: room.turn,
                myIndex: index,
                deckCount: room.deck.length,
                isMyTurn: index === room.turn && !isWaitingAction,
                pool: room.pool,
                lastPlayed: room.lastPlayed
            });
        });
    }

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            const p = room.players.find(player => player.id === socket.id);
            if (p) {
                room.disconnectTimeouts[p.name] = setTimeout(() => {
                    io.to(roomCode).emit('errorMessage', `玩家 ${p.name} 離開遊戲。`);
                    delete rooms[roomCode];
                }, 15000);
                break;
            }
        }
    });
});

server.listen(process.env.PORT || 3000);
