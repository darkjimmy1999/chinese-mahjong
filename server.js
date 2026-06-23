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

// 判定是否為清一色（全紅或全黑）
function isPureColor(hand, melds) {
    let allCards = [...hand];
    melds.forEach(m => allCards.push(...m.cards));
    const redCards = ['帥', '仕', '相', '車', '馬', '炮', '兵'];
    
    let hasRed = allCards.some(c => redCards.includes(c));
    let hasBlack = allCards.some(c => !redCards.includes(c));
    return !(hasRed && hasBlack); // 不能同時有紅有黑
}

function checkWinPattern(hand, melds = []) {
    let allCards = [...hand];
    melds.forEach(m => allCards.push(...m.cards));
    if (allCards.length !== 8) return false;
    return canDecompose([...hand].sort(), false);
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
    const eatGroups = [['將', '士', '象'], ['帥', '仕', '相'], ['車', '馬', '包'], ['車', '馬', '炮']];
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

function getChowChoices(hand, card) {
    const eatGroups = [['將', '士', '象'], ['帥', '仕', '相'], ['車', '馬', '包'], ['車', '馬', '炮']];
    let choices = [];
    for (let group of eatGroups) {
        if (group.includes(card)) {
            let needed = group.filter(c => c !== card);
            if (hand.includes(needed[0]) && hand.includes(needed[1])) choices.push(group); 
        }
    }
    return choices;
}

io.on('connection', (socket) => {
    socket.on('joinRoom', ({ username, avatar, roomCode }) => {
        if (!roomCode || !username) return;
        socket.join(roomCode);

        if (!rooms[roomCode]) {
            rooms[roomCode] = { players: [], deck: [], turn: 0, pool: [], status: 'waiting', lastPlayed: null, pendingActions: {}, disconnectTimeouts: {} };
        }

        const room = rooms[roomCode];
        const existingPlayer = room.players.find(p => p.name === username);
        
        if (existingPlayer) {
            existingPlayer.id = socket.id;
            existingPlayer.avatar = avatar; // 更新頭像
            if (room.disconnectTimeouts[username]) clearTimeout(room.disconnectTimeouts[username]);
            if (room.status === 'playing') sendStateToAll(roomCode);
            return;
        }

        if (room.status === 'playing' || room.players.length >= 4) {
            socket.emit('errorMessage', '無法加入該房間！');
            return;
        }

        // 每個玩家初始擁有 300 元
        room.players.push({ id: socket.id, name: username, avatar: avatar || '🐱', money: 300, hand: [], melds: [] });
        io.to(roomCode).emit('roomUpdated', room.players.map(p => ({name: p.name, avatar: p.avatar})));

        if (room.players.length === 4) {
            room.status = 'playing';
            room.deck = shuffleDeck();
            room.pool = [];
            room.turn = Math.floor(Math.random() * 4); // 隨機選莊家

            for (let i = 0; i < 4; i++) {
                room.players[i].hand = room.deck.splice(0, 7);
                room.players[i].melds = [];
            }
            room.players[room.turn].hand.push(room.deck.splice(0, 1)[0]);
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
            let canKong = p.hand.filter(c => c === playedCard).length === 3; // 明槓
            let chowChoices = (idx === (room.turn + 1) % 4) ? getChowChoices(p.hand, playedCard) : [];
            let canChow = chowChoices.length > 0;
            let canWin = checkWinPattern([...p.hand, playedCard], p.melds);

            if (canPong || canKong || canChow || canWin) {
                hasInterception = true;
                room.pendingActions[p.id] = { canPong, canKong, canChow, chowChoices, canWin, decided: false, action: null, details: null };
                io.to(p.id).emit('askInterception', { card: playedCard, canPong, canKong, canChow, chowChoices, canWin });
            }
        });

        // 檢查出牌者自己是否有「暗槓」或「補槓」的機會
        let myHandCount = player.hand.filter(c => c === player.hand[player.hand.length - 1]).length;

        if (hasInterception) {
            sendStateToAll(roomCode, true); 
        } else {
            nextTurn(roomCode);
        }
    });

    // 處理手牌中自己暗槓
    socket.on('declareAnKong', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        if (player.hand.filter(c => c === card).length === 4) {
            // 扣除4張手牌，加入亮牌區
            for(let i=0; i<4; i++) player.hand.splice(player.hand.indexOf(card), 1);
            player.melds.push({ type: '槓', cards: [card, card, card, card] });
            // 槓牌後要摸一張新牌（補牌）
            player.hand.push(room.deck.splice(0, 1)[0]);
            sendStateToAll(roomCode);
        }
    });

    socket.on('respondInterception', ({ roomCode, action, details }) => {
        const room = rooms[roomCode];
        if (!room || !room.pendingActions[socket.id]) return;

        room.pendingActions[socket.id].decided = true;
        room.pendingActions[socket.id].action = action; // 'pong', 'kong', 'chow', 'win', 'pass'
        room.pendingActions[socket.id].details = details;

        let allDecided = Object.values(room.pendingActions).every(a => a.decided);
        if (allDecided) {
            let winId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'win');
            let kongId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'kong');
            let pongId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'pong');
            let chowId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'chow');

            if (winId) {
                // 胡牌結算邏輯
                const winner = room.players.find(p => p.id === winId);
                const loser = room.players[room.lastPlayed.playerIndex]; // 放銃的人
                let isPure = isPureColor(winner.hand, winner.melds);
                let score = isPure ? 100 : 50;

                loser.money -= score;
                winner.money += score;

                io.to(roomCode).emit('gameOver', { winner: winner.name, reason: `胡了 ${loser.name} 的「${room.lastPlayed.card}」！${isPure?'(清一色) ':''}獨得 ${score} 元！💵`, playersStatus: room.players.map(p=>({name:p.name, money:p.money})) });
                room.status = 'waiting';
            } else if (kongId) {
                executeMeld(roomCode, kongId, 'kong');
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

        room.pool.pop();
        
        if (type === 'pong') {
            player.hand.splice(player.hand.indexOf(card), 1);
            player.hand.splice(player.hand.indexOf(card), 1);
            player.melds.push({ type: '碰', cards: [card, card, card] });
        } else if (type === 'kong') {
            // 明槓：扣3張手牌
            for(let i=0; i<3; i++) player.hand.splice(player.hand.indexOf(card), 1);
            player.melds.push({ type: '槓', cards: [card, card, card, card] });
            player.hand.push(room.deck.splice(0, 1)[0]); // 槓牌要摸一張補牌
        } else if (type === 'chow') {
            details.forEach(c => {
                if (c !== card) player.hand.splice(player.hand.indexOf(c), 1);
            });
            player.melds.push({ type: '吃', cards: details });
        }

        room.turn = pIdx;
        room.lastPlayed = null;
        room.pendingActions = {};
        sendStateToAll(roomCode);
    }

    // 自摸結算邏輯
    socket.on('claimWin', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;
        const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.turn) return;

        const player = room.players[pIdx];
        if (checkWinPattern(player.hand, player.melds)) {
            let isPure = isPureColor(player.hand, player.melds);
            let scoreEach = isPure ? 150 : 100; // 每家要給的金額

            room.players.forEach((p, idx) => {
                if (idx !== pIdx) {
                    p.money -= scoreEach;
                    player.money += scoreEach;
                }
            });

            io.to(roomCode).emit('gameOver', { winner: player.name, reason: `自摸胡牌了！${isPure?'(清一色) ':''}三家各給 ${scoreEach} 元！🎉`, playersStatus: room.players.map(p=>({name:p.name, money:p.money})) });
            room.status = 'waiting';
        } else {
            socket.emit('errorMessage', '不符合胡牌牌型喔！');
        }
    });

    function nextTurn(roomCode) {
        const room = rooms[roomCode];
        if (room.deck.length === 0) {
            io.to(roomCode).emit('gameOver', { winner: '流局', reason: '牌組已摸完！', playersStatus: room.players.map(p=>({name:p.name, money:p.money})) });
            room.status = 'waiting';
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
            let playersStatus = room.players.map((p, idx) => ({
                name: p.name,
                avatar: p.avatar,
                money: p.money,
                handCount: p.hand.length,
                melds: p.melds
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
        // 免費版容錯保留
    });
});

server.listen(process.env.PORT || 3000);
