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
const globalMoneyLedger = {}; 

const BASE_DECK = [
    '帥', '仕', '仕', '相', '相', '車', '車', '馬', '馬', '炮', '炮', '兵', '兵', '兵', '兵', '兵',
    '將', '士', '士', '象', '象', '車', '車', '馬', '馬', '包', '包', '卒', '卒', '卒', '卒', '卒'
];
const ORIGINAL_DECK = [...BASE_DECK, ...BASE_DECK];

const CARD_ORDER = {
    '帥': 1, '仕': 2, '相': 3, '車': 4, '馬': 5, '炮': 6, '兵': 7,
    '將': 8, '士': 9, '象': 10, '車': 11, '馬': 12, '包': 13, '卒': 14
};

function sortHand(hand) {
    return [...hand].sort((a, b) => CARD_ORDER[a] - CARD_ORDER[b]);
}

function shuffleDeck() {
    let deck = [...ORIGINAL_DECK];
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function isPureColor(hand, melds) {
    let allCards = [...hand];
    melds.forEach(m => allCards.push(...m.cards));
    const redCards = ['帥', '仕', '相', '車', '馬', '炮', '兵'];
    let hasRed = allCards.some(c => redCards.includes(c));
    let hasBlack = allCards.some(c => !redCards.includes(c));
    return !(hasRed && hasBlack);
}

function checkWinPattern(hand, melds = []) {
    let allCards = [...hand];
    melds.forEach(m => allCards.push(...m.cards));
    if (allCards.length !== 8) return false;
    return canDecompose([...hand].sort((a,b)=>CARD_ORDER[a]-CARD_ORDER[b]), false);
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

        if (!rooms[roomCode] || rooms[roomCode].status === 'waiting') {
            rooms[roomCode] = { players: [], deck: [], turn: 0, pool: [], status: 'waiting', lastPlayed: null, pendingActions: {}, disconnectTimeouts: {} };
        }

        const room = rooms[roomCode];
        const existingPlayer = room.players.find(p => p.name === username);
        
        if (existingPlayer) {
            existingPlayer.id = socket.id;
            existingPlayer.avatar = avatar;
            if (room.disconnectTimeouts[username]) clearTimeout(room.disconnectTimeouts[username]);
            if (room.status === 'playing') sendStateToAll(roomCode);
            return;
        }

        if (room.players.length >= 4) {
            socket.emit('errorMessage', '該房間人數已滿！');
            return;
        }

        if (globalMoneyLedger[username] === undefined) {
            globalMoneyLedger[username] = 300;
        }

        room.players.push({ 
            id: socket.id, 
            name: username, 
            avatar: avatar || '🐱', 
            money: globalMoneyLedger[username], 
            hand: [], 
            melds: [], 
            newCard: null 
        });
        
        io.to(roomCode).emit('roomUpdated', room.players.map(p => ({name: p.name, avatar: p.avatar})));

        if (room.players.length === 4) {
            room.status = 'playing';
            room.deck = shuffleDeck(); 
            room.pool = [];            
            room.lastPlayed = null;
            room.turn = Math.floor(Math.random() * 4);

            for (let i = 0; i < 4; i++) {
                room.players[i].hand = sortHand(room.deck.splice(0, 7)); 
                room.players[i].melds = [];                             
                room.players[i].newCard = null;
                room.players[i].money = globalMoneyLedger[room.players[i].name]; 
            }
            
            let pCard = room.deck.splice(0, 1)[0];
            room.players[room.turn].hand.push(pCard);
            room.players[room.turn].newCard = pCard;

            if (checkWinPattern(room.players[room.turn].hand, room.players[room.turn].melds)) {
                executeZimoWin(roomCode, room.turn);
                return;
            }

            sendStateToAll(roomCode);
        }
    });

    socket.on('playCard', ({ roomCode, cardIndex }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing' || room.turn !== room.players.findIndex(p => p.id === socket.id)) return;

        const player = room.players[room.turn];
        player.newCard = null;
        
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        player.hand = sortHand(player.hand);

        room.lastPlayed = { card: playedCard, playerIndex: room.turn };
        room.pool.push(playedCard); 

        // ⚡️ 全自動胡牌優先判定
        let automaticWinPlayerIdx = -1;
        room.players.forEach((p, idx) => {
            if (idx === room.turn) return;
            if (checkWinPattern([...p.hand, playedCard], p.melds)) {
                automaticWinPlayerIdx = idx;
            }
        });

        if (automaticWinPlayerIdx !== -1) {
            executeHuWin(roomCode, automaticWinPlayerIdx, room.turn, playedCard);
            return;
        }

        // 🔍【核心修正】動態過濾攔截者：沒事的人，絕不建立 Action 紀錄
        room.pendingActions = {};
        let hasInterception = false;

        room.players.forEach((p, idx) => {
            if (idx === room.turn) return;

            let canPong = p.hand.filter(c => c === playedCard).length >= 2;
            let canKong = p.hand.filter(c => c === playedCard).length === 3;
            let chowChoices = (idx === (room.turn + 1) % 4) ? getChowChoices(p.hand, playedCard) : [];
            let canChow = chowChoices.length > 0;

            // 💡 只有真正有資格吃/碰/槓的人，才會被列入「必須等待回應」的名單
            if (canPong || canKong || canChow) {
                hasInterception = true;
                room.pendingActions[p.id] = { canPong, canKong, canChow, chowChoices, canWin: false, decided: false, action: null, details: null };
                io.to(p.id).emit('askInterception', { card: playedCard, canPong, canKong, canChow, chowChoices, canWin: false });
            }
        });

        if (hasInterception) {
            // 有人有動作，大腦發送狀態，但標記為「正處於攔截等待中」
            sendStateToAll(roomCode, true); 
        } else {
            // ✅ 如果全場另外三個人都沒他的事，0毫秒都不等，直接下一家摸牌！
            nextTurn(roomCode);
        }
    });

    socket.on('declareAnKong', ({ roomCode, card }) => {
        const room = rooms[roomCode];
        if (!room) return;
        const player = room.players.find(p => p.id === socket.id);
        const pIdx = room.players.findIndex(p => p.id === socket.id);
        
        if (player.hand.filter(c => c === card).length === 4) {
            player.hand = player.hand.filter(c => c !== card);
            player.melds.push({ type: '槓', cards: [card, card, card, card] });
            
            let drawn = room.deck.splice(0, 1)[0];
            player.hand.push(drawn);
            player.newCard = drawn;
            
            if (checkWinPattern(player.hand, player.melds)) {
                executeZimoWin(roomCode, pIdx);
                return;
            }

            sendStateToAll(roomCode);
        }
    });

    socket.on('respondInterception', ({ roomCode, action, details }) => {
        const room = rooms[roomCode];
        if (!room || !room.pendingActions[socket.id]) return;

        room.pendingActions[socket.id].decided = true;
        room.pendingActions[socket.id].action = action;
        room.pendingActions[socket.id].details = details;

        // ✅ 大腦只會審查「有資格操作的人」是否都做決定了
        let allDecided = Object.values(room.pendingActions).every(a => a.decided);
        if (allDecided) {
            let kongId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'kong');
            let pongId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'pong');
            let chowId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'chow');

            if (kongId) {
                executeMeld(roomCode, kongId, 'kong');
            } else if (pongId) {
                executeMeld(roomCode, pongId, 'pong');
            } else if (chowId) {
                executeMeld(roomCode, chowId, 'chow', room.pendingActions[chowId].details);
            } else {
                // 如果能吃碰的人最後都按了「取消（pass）」，順移到下一家
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
            for(let i=0; i<3; i++) player.hand.splice(player.hand.indexOf(card), 1);
            player.melds.push({ type: '槓', cards: [card, card, card, card] });
            
            let drawn = room.deck.splice(0, 1)[0];
            player.hand.push(drawn);
            player.newCard = drawn;

            if (checkWinPattern(player.hand, player.melds)) {
                executeZimoWin(roomCode, pIdx);
                return;
            }
        } else if (type === 'chow') {
            details.forEach(c => {
                if (c !== card) player.hand.splice(player.hand.indexOf(c), 1);
            });
            player.melds.push({ type: '吃', cards: details });
        }

        player.hand = sortHand(player.hand);
        if (type !== 'kong') player.newCard = null; 

        room.turn = pIdx;
        room.lastPlayed = null;
        room.pendingActions = {};
        sendStateToAll(roomCode);
    }

    function executeHuWin(roomCode, winnerIdx, loserIdx, card) {
        const room = rooms[roomCode];
        const winner = room.players[winnerIdx];
        const loser = room.players[loserIdx];
        
        room.pool.pop(); 
        winner.hand.push(card);
        winner.hand = sortHand(winner.hand);

        let isPure = isPureColor(winner.hand, winner.melds);
        let score = isPure ? 100 : 50;

        winner.money += score;
        loser.money -= score;

        room.players.forEach(p => globalMoneyLedger[p.name] = p.money);
        room.status = 'waiting'; 

        io.to(roomCode).emit('gameOver', { 
            winner: winner.name, 
            reason: `⚡️系統判定：${winner.name} 胡了 ${loser.name} 的「${card}」！${isPure?'(清一色) ':''}獨得 ${score} 元！💵`, 
            playersStatus: room.players.map(p=>({name:p.name, avatar:p.avatar, money:p.money, hand:p.hand, melds:p.melds})) 
        });
    }

    function executeZimoWin(roomCode, winnerIdx) {
        const room = rooms[roomCode];
        const winner = room.players[winnerIdx];
        let isPure = isPureColor(winner.hand, winner.melds);
        let scoreEach = isPure ? 150 : 100;

        room.players.forEach((p, idx) => {
            if (idx !== winnerIdx) {
                p.money -= scoreEach;
                winner.money += scoreEach;
            }
        });

        room.players.forEach(p => globalMoneyLedger[p.name] = p.money);
        room.status = 'waiting'; 

        io.to(roomCode).emit('gameOver', { 
            winner: winner.name, 
            reason: `⚡️系統判定：${winner.name} 自摸胡牌了！${isPure?'(清一色) ':''}三家各給 ${scoreEach} 元！🎉`, 
            playersStatus: room.players.map(p=>({name:p.name, avatar:p.avatar, money:p.money, hand:p.hand, melds:p.melds})) 
        });
    }

    function nextTurn(roomCode) {
        const room = rooms[roomCode];
        if (room.deck.length === 0) {
            room.status = 'waiting';
            io.to(roomCode).emit('gameOver', { winner: '流局', reason: '牌組已摸完！', playersStatus: room.players.map(p=>({name:p.name, money:p.money, hand:p.hand, melds:p.melds})) });
            return;
        }
        
        room.players[room.turn].newCard = null;
        room.players[room.turn].hand = sortHand(room.players[room.turn].hand);

        room.turn = (room.turn + 1) % 4;
        let nextPlayer = room.players[room.turn];
        let drawn = room.deck.splice(0, 1)[0];
        
        nextPlayer.hand = sortHand(nextPlayer.hand);
        nextPlayer.hand.push(drawn);
        nextPlayer.newCard = drawn;

        if (checkWinPattern(nextPlayer.hand, nextPlayer.melds)) {
            executeZimoWin(roomCode, room.turn);
            return;
        }

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
                newCard: player.newCard,
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
});

server.listen(process.env.PORT || 3000);
