const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
    if (req.url === '/' || req.url === '/index.html') {
        fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
            if (err) { res.writeHead(500); return res.end('Error loading index.html'); }
            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(data);
        });
    } else { res.writeHead(404); res.end('Not found'); }
});

const wss = new WebSocket.Server({ server });
const rooms = new Map();

function broadcast(roomId, message) {
    const room = rooms.get(roomId);
    if (!room) return;
    room.players.forEach(p => {
        if (p.isOnline && p.ws && p.ws.readyState === WebSocket.OPEN) {
            const safeRoomState = JSON.parse(JSON.stringify(room));
            safeRoomState.players.forEach(safePlayer => {
                if (safePlayer.id !== p.id && safeRoomState.phase !== 'reveal') {
                    safePlayer.dice = safePlayer.dice.map(() => '?'); 
                }
                delete safePlayer.ws; 
            });
            p.ws.send(JSON.stringify({ type: 'gameStateUpdate', state: safeRoomState, yourId: p.id, message }));
        }
    });
}

function calculateDicePower(diceArray, callVal, isZhai) {
    const unique = new Set(diceArray).size;
    if (unique === 5) return { val: 0, isSingle: true, desc: '单骰(算0个)' };
    
    let targets = 0; let ones = 0;
    diceArray.forEach(d => { if (d === callVal) targets++; else if (d === 1) ones++; });
    
    if (callVal === 1) {
        if (targets === 5) return { val: 8, isSingle: false, desc: '纯数字围骰(算8个)' };
        return { val: targets, isSingle: false, desc: `${targets}个` };
    } else {
        if (targets === 5) return { val: 8, isSingle: false, desc: '纯数字围骰(算8个)' };
        if (!isZhai && (targets + ones === 5)) return { val: 7, isSingle: false, desc: '飞组合围骰(算7个)' };
        let val = targets + (isZhai ? 0 : ones);
        return { val: val, isSingle: false, desc: `${val}个` };
    }
}

// 辅助函数：斋模式下判断点数大小（1最大）
function getZhaiRank(val) {
    return val === 1 ? 7 : val;
}

// 辅助函数：计算 N 盘几胜 (例如 3盘2胜, 5盘3胜)
function getWinThreshold(totalGames) {
    return Math.floor(totalGames / 2) + 1;
}

wss.on('connection', (ws) => {
    let currentRoomId = null;

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            if (data.type === 'ping') {
                return ws.send(JSON.stringify({ type: 'pong' }));
            }

            if (data.type === 'createRoom') {
                const roomId = Math.random().toString(36).substring(2, 6).toUpperCase();
                currentRoomId = roomId;
                
                const settings = data.settings || { mode: 'infinite' };

                rooms.set(roomId, {
                    roomId: roomId,
                    settings: settings,
                    scores: {}, 
                    largeScores: {}, 
                    isGameOver: false, 
                    finalWinner: null,
                    history: [], 
                    // 【优化点】：建房时直接给予预热数组 [1, 1, 1, 1, 1]
                    players: [{ id: data.userId, ws: ws, dice: [1, 1, 1, 1, 1], isReady: false, isOnline: true }],
                    currentTurn: null,
                    lastLoser: null, 
                    currentCall: { count: 0, value: 0, isZhai: false },
                    phase: 'waiting'
                });
                
                rooms.get(roomId).scores[data.userId] = 0;
                rooms.get(roomId).largeScores[data.userId] = 0;

                ws.send(JSON.stringify({ type: 'roomCreated', roomId: roomId }));
                broadcast(roomId, '房间创建成功，等待对手...');
            }

            if (data.type === 'joinRoom') {
                const roomId = data.roomId.toUpperCase();
                const room = rooms.get(roomId);
                if (!room) return ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));

                currentRoomId = roomId;

                if (room.destroyTimer) { clearTimeout(room.destroyTimer); room.destroyTimer = null; }

                let existingPlayer = room.players.find(p => p.id === data.userId);
                if (existingPlayer) {
                    existingPlayer.ws = ws;
                    existingPlayer.isOnline = true;
                    broadcast(roomId, '已重连恢复游戏状态！');
                } else {
                    if (room.players.length >= 2) return ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
                    // 【优化点】：进房时直接给予预热数组 [1, 1, 1, 1, 1]
                    room.players.push({ id: data.userId, ws: ws, dice: [1, 1, 1, 1, 1], isReady: false, isOnline: true });
                    
                    if (!(data.userId in room.scores)) room.scores[data.userId] = 0;
                    if (!(data.userId in room.largeScores)) room.largeScores[data.userId] = 0;

                    broadcast(roomId, '玩家已加入，请摇骰子！');
                }
            }

            if (data.type === 'leaveRoom') {
                const room = rooms.get(currentRoomId);
                if (room) {
                    room.players = room.players.filter(p => p.id !== data.userId);
                    if (room.players.length === 0) {
                        if (room.destroyTimer) clearTimeout(room.destroyTimer);
                        rooms.delete(currentRoomId);
                    } else {
                        room.phase = 'waiting';
                        room.players.forEach(p => p.isReady = false);
                        broadcast(currentRoomId, '⚠️ 对方已退出当前房间，等待新玩家...');
                    }
                }
                ws.send(JSON.stringify({ type: 'leftRoom' }));
                currentRoomId = null;
            }

            if (data.type === 'rollDice') {
                const room = rooms.get(currentRoomId);
                if (!room || room.phase === 'playing' || room.isGameOver) return;

                const player = room.players.find(p => p.id === data.userId);
                if (player) {
                    player.dice = Array.from({ length: 5 }, () => Math.floor(Math.random() * 6) + 1);
                    player.isReady = true;

                    if (room.players.length === 2 && room.players.every(p => p.isReady)) {
                        room.phase = 'playing';
                        room.currentTurn = room.lastLoser || room.players[0].id;
                        room.currentCall = { count: 0, value: 0, isZhai: false };
                        broadcast(currentRoomId, '对局开始！');
                    } else {
                        broadcast(currentRoomId, '等待另一方摇骰...');
                    }
                }
            }

            if (data.type === 'callDice') {
                const room = rooms.get(currentRoomId);
                if (!room || room.phase !== 'playing' || room.currentTurn !== data.userId) return;

                const { count, value, isZhai } = data;
                const isZhaiBool = Boolean(isZhai);
                const curr = room.currentCall;
                const playerCount = room.players.length;

                let isValid = false;

                if (curr.count === 0) {
                    if (count === playerCount) {
                        if (value === 1 && isZhaiBool) isValid = true;
                    } else if (count >= playerCount + 1) {
                        isValid = true;
                    }
                } else {
                    if (!curr.isZhai && !isZhaiBool) {
                        if (count > curr.count || (count === curr.count && value > curr.value)) isValid = true;
                    } else if (!curr.isZhai && isZhaiBool) {
                        if (count >= curr.count - 1) isValid = true;
                    } else if (curr.isZhai && isZhaiBool) {
                        if (count > curr.count || (count === curr.count && getZhaiRank(value) > getZhaiRank(curr.value))) isValid = true;
                    } else if (curr.isZhai && !isZhaiBool) {
                        if (count >= curr.count * 2) isValid = true;
                    }
                }

                if (isValid) {
                    room.currentCall = { count, value, isZhai: value === 1 ? true : isZhaiBool };
                    room.currentTurn = room.players.find(p => p.id !== data.userId).id;
                    broadcast(currentRoomId, `叫点更新`);
                } else {
                    ws.send(JSON.stringify({ type: 'error', message: '叫点不符合规则！' }));
                }
            }

            if (data.type === 'challenge') {
                const room = rooms.get(currentRoomId);
                if (!room || room.phase !== 'playing' || room.currentTurn !== data.userId || room.currentCall.count === 0) return;

                room.phase = 'reveal';
                const call = room.currentCall;
                const challengerId = data.userId;
                const callerId = room.players.find(p => p.id !== data.userId).id;
                
                const challenger = room.players.find(p => p.id === challengerId);
                const caller = room.players.find(p => p.id === callerId);

                const challengerStats = calculateDicePower(challenger.dice, call.value, call.isZhai);
                const callerStats = calculateDicePower(caller.dice, call.value, call.isZhai);

                const bothSingle = challengerStats.isSingle && callerStats.isSingle;
                let challengeSuccess = false;
                
                if (bothSingle) challengeSuccess = false; 
                else {
                    const totalMatch = challengerStats.val + callerStats.val;
                    challengeSuccess = totalMatch < call.count;
                }

                const winnerId = challengeSuccess ? challengerId : callerId;
                const loserId = challengeSuccess ? callerId : challengerId;

                room.lastLoser = loserId;

                let finalGameOver = false;
                let matchOverStr = "";

                if (room.settings && room.settings.mode === 'turn' && !room.isGameOver) {
                    room.scores[winnerId] = (room.scores[winnerId] || 0) + 1;
                    const smallReq = getWinThreshold(room.settings.smallCount);

                    if (room.scores[winnerId] >= smallReq) {
                        if (room.settings.turnType === 'large') {
                            room.largeScores[winnerId] = (room.largeScores[winnerId] || 0) + 1;
                            room.scores[challengerId] = 0; 
                            room.scores[callerId] = 0;
                            matchOverStr = `🎲 小回合结束！进入下一局！`;
                            
                            const largeReq = getWinThreshold(room.settings.largeCount);
                            if (room.largeScores[winnerId] >= largeReq) {
                                finalGameOver = true;
                            }
                        } else {
                            finalGameOver = true;
                        }
                    }
                }

                if (finalGameOver) {
                    room.isGameOver = true;
                    room.finalWinner = winnerId;
                }

                room.result = {
                    winner: winnerId,
                    loser: loserId,
                    challengerId: challengerId,
                    bothSingle: bothSingle,
                    totalMatch: challengerStats.val + callerStats.val,
                    callCount: call.count,
                    callValue: call.value,
                    mode: call.isZhai ? '斋' : '飞',
                    challengerDesc: challengerStats.desc,
                    callerDesc: callerStats.desc,
                    finalGameOver: finalGameOver,
                    finalWinner: room.finalWinner,
                    matchOverStr: matchOverStr,
                    prize: room.settings ? room.settings.prize : []
                };

                if (!room.history) room.history = []; 
                room.history.push({
                    call: { count: call.count, value: call.value, mode: call.isZhai ? '斋' : '飞' },
                    challengerId: challengerId,
                    winnerId: winnerId,
                    player1: { id: challenger.id, dice: [...challenger.dice] },
                    player2: { id: caller.id, dice: [...caller.dice] }
                });

                room.players.forEach(p => p.isReady = false);
                broadcast(currentRoomId, finalGameOver ? '🎉 回合制对局彻底结束！' : '开牌结算！');
            }
        } catch (error) {
            console.error("处理消息失败:", error);
            ws.send(JSON.stringify({ type: 'error', message: '后台计算出错: ' + error.message }));
        }
    });

    ws.on('close', () => {
        if (currentRoomId && rooms.has(currentRoomId)) {
            const room = rooms.get(currentRoomId);
            const player = room.players.find(p => p.ws === ws);
            if (player) {
                player.isOnline = false;
                player.ws = null;
            }
            
            if (room.players.every(p => !p.isOnline)) {
                room.destroyTimer = setTimeout(() => rooms.delete(currentRoomId), 15 * 60 * 1000);
            } else {
                broadcast(currentRoomId, '⚠️ 对手已掉线(可能切到了后台)，等待对方重连...');
            }
        }
    });
});

const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));