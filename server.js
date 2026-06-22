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

// 🀄️ 象棋麻將胡牌驗證演算法 (8張牌)
function checkWinPattern(hand) {
    if (hand.length !== 8) return false;
    
    // 複製一份牌組並排序，方便組合比對
    let sortedHand = [...hand].sort();
    
    // 遞迴嘗試找出所有的搭子（組合）與將眼（對子）
    return canDecompose(sortedHand, false);
}

function canDecompose(cards, hasEye) {
    if (cards.length === 0) return hasEye; // 牌全部分解完，且有眼（對子）就贏了

    // 狀況 A：嘗試找對子 (將眼)
    if (!hasEye) {
        for (let i = 0; i < cards.length - 1; i++) {
            if (cards[i] === cards[i+1]) {
                let remaining = [...cards];
                remaining.splice(i, 2);
                if (canDecompose(remaining, true)) return true;
            }
        }
    }

    // 狀況 B：嘗試拿前三張牌湊成合法的「搭子」
    // 象棋麻將合法刻子/順子：同字3張、將士象、車馬包、兵兵兵、卒卒卒等
    let c1 = cards[0];
    
    // 1. 三張一樣的 (刻子)
    if (cards.filter(c => c === c1).length >= 3) {
        let remaining = [...cards];
        remaining.splice(0, 3);
        if (canDecompose(remaining, hasEye)) return true;
    }

    // 2. 特殊對子/順子組合：將士象
    if (c1 === '將' || c1 === '士' || c1 === '象') {
        if (cards.includes('將') && cards.includes('士') && cards.includes('象')) {
            let remaining = [...cards];
            remaining.splice(remaining.indexOf('將'), 1);
            remaining.splice(remaining.indexOf('士'), 1);
            remaining.splice(remaining.indexOf('象'), 1);
            if (canDecompose(remaining, hasEye)) return true;
        }
    }
    // 3. 特殊對子/順子組合：帥仕相
    if (c1 === '帥' || c1 === '仕' || c1 === '相') {
        if (cards.includes('帥') && cards.includes('仕') && cards.includes('相')) {
            let remaining = [...cards];
            remaining.splice(remaining.indexOf('帥'), 1);
            remaining.splice(remaining.indexOf('仕'), 1);
            remaining.splice(remaining.indexOf('相'), 1);
            if (canDecompose(remaining, hasEye)) return true;
        }
    }
    // 4. 特殊對子/順子組合：車馬包 / 車馬炮
    if (c1 === '車' || c1 === '馬' || c1 === '包' || c1 === '炮') {
        // 黑車馬包
        if (cards.includes('車') && cards.includes('馬') && cards.includes('包')) {
            let remaining = [...cards];
            remaining.splice(remaining.indexOf('車'), 1);
            remaining.splice(remaining.indexOf('馬'), 1);
            remaining.splice(remaining.indexOf('包'), 1);
            if (canDecompose(remaining, hasEye)) return true;
        }
        // 紅車馬炮
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
            rooms[roomCode] = { players: [], deck: [], turn: 0, pool: [], status: 'waiting', lastPlayed: null, pendingActions: {} };
        }

        const room = rooms[roomCode];
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
            // 莊家多摸一張
            room.players[0].hand.push(room.deck.splice(0, 1)[0]);

            sendStateToAll(roomCode);
        }
    });

    // 玩家打牌
    socket.on('playCard', ({ roomCode, cardIndex }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing' || room.turn !== room.players.findIndex(p => p.id === socket.id)) return;

        const player = room.players[room.turn];
        const playedCard = player.hand.splice(cardIndex, 1)[0];
        room.lastPlayed = { card: playedCard, playerIndex: room.turn };
        room.pool.push(playedCard);

        // 進入「攔截詢問階段」，檢查其他三家是否能 碰 或 胡 這張牌
        room.pendingActions = {};
        let hasInterception = false;

        room.players.forEach((p, idx) => {
            if (idx === room.turn) return; // 出牌者自己不能碰/胡自己的牌

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
            // 有人可以攔截，暫停往下摸牌，等待按鈕回應
            sendStateToAll(roomCode, true); 
        } else {
            // 無人可以攔截，直接進入下一個人摸牌的回合
            nextTurn(roomCode);
        }
    });

    // 處理碰牌或胡牌的抉擇
    socket.on('respondInterception', ({ roomCode, action }) => {
        const room = rooms[roomCode];
        if (!room || !room.pendingActions[socket.id]) return;

        room.pendingActions[socket.id].decided = true;
        room.pendingActions[socket.id].action = action; // 'pong', 'win', 或 'pass'

        // 檢查是不是所有有資格攔截的人都做決定了
        let allDecided = Object.values(room.pendingActions).every(a => a.decided);
        if (allDecided) {
            // 優先權：胡 > 碰 > 過
            let winPlayerId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'win');
            let pongPlayerId = Object.keys(room.pendingActions).find(id => room.pendingActions[id].action === 'pong');

            if (winPlayerId) {
                // 成功放銃胡牌
                const winner = room.players.find(p => p.id === winPlayerId);
                io.to(roomCode).emit('gameOver', { winner: winner.name, reason: `胡了別人打的「${room.lastPlayed.card}」！🎉` });
                delete rooms[roomCode];
            } else if (pongPlayerId) {
                // 成功碰牌
                const pIdx = room.players.findIndex(p => p.id === pongPlayerId);
                const player = room.players[pIdx];
                
                // 從牌河拿走那張牌
                room.pool.pop();
                // 扣掉手牌兩張，再放進去，手牌剛好變 8 張（需要打出一張）
                player.hand.push(room.lastPlayed.card);
                
                room.turn = pIdx; // 回合強制切換到碰牌的人
                room.lastPlayed = null;
                room.pendingActions = {};
                sendStateToAll(roomCode);
            } else {
                // 大家都要 pass，順移到下一家
                nextTurn(roomCode);
            }
        }
    });

    // 自摸胡牌按鈕
    socket.on('claimWin', ({ roomCode }) => {
        const room = rooms[roomCode];
        if (!room || room.status !== 'playing') return;

        const pIdx = room.players.findIndex(p => p.id === socket.id);
        if (pIdx !== room.turn) return; // 必須是自己回合才能自摸

        const player = room.players[pIdx];
        
        // 系統嚴格驗證自摸胡牌
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

    socket.on('disconnect', () => {
        for (const roomCode in rooms) {
            const room = rooms[roomCode];
            if (room.players.some(p => p.id === socket.id)) {
                io.to(roomCode).emit('errorMessage', '有玩家斷線，遊戲結束。');
                delete rooms[roomCode];
                break;
            }
        }
    });
});

server.listen(process.env.PORT || 3000);
