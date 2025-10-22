const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');
const path = require('path');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"],
        credentials: true
    }
});

app.use(cors());
app.use(express.json());

// Serve static files
app.use(express.static(path.join(__dirname, 'public')));

// Store connected operators
const operators = new Map();
// Store active chat sessions
const sessions = new Map();
// Queue for users waiting for operators
const waitingQueue = [];

io.on('connection', (socket) => {
    console.log('🟡 New connection:', socket.id);

    socket.on('register_operator', (data) => {
        operators.set(socket.id, {
            id: data.operatorId,
            name: data.name,
            socketId: socket.id,
            status: 'online'
        });
        console.log(`✅ Operator ${data.name} registered`);
        
        // Check if there are waiting users
        if (waitingQueue.length > 0) {
            assignOperatorToWaitingUser();
        }
    });

    socket.on('register_user', (data) => {
        const userId = data.userId;
        
        // Check if there's available operator
        const availableOperator = getAvailableOperator();
        
        if (availableOperator) {
            // Assign operator immediately
            createSession(socket.id, userId, availableOperator.id);
            
            // Notify user
            io.to(socket.id).emit('operator_assigned', {
                operatorId: availableOperator.id,
                operatorName: availableOperator.name
            });
            
            // Notify operator
            io.to(availableOperator.socketId).emit('new_user', {
                userId: userId,
                socketId: socket.id
            });
            
            console.log(`✅ User ${userId} assigned to operator ${availableOperator.name}`);
        } else {
            // Add to waiting queue
            waitingQueue.push({
                socketId: socket.id,
                userId: userId
            });
            
            console.log(`⏳ User ${userId} added to waiting queue`);
            
            // Check queue periodically
            checkQueuePeriodically();
        }
    });

    socket.on('send_message', (data) => {
        const session = getSessionByUserId(data.userId);
        
        if (session && session.operatorId) {
            // Find operator socket
            const operator = Array.from(operators.values())
                .find(op => op.id === session.operatorId);
            
            if (operator) {
                // Send to operator
                io.to(operator.socketId).emit('new_message', {
                    message: data.message,
                    userId: data.userId,
                    timestamp: new Date()
                });
                
                console.log(`📤 Message from ${data.userId} to operator ${operator.name}: ${data.message}`);
            }
        } else if (operators.has(socket.id)) {
            // Operator sending to user
            const targetSession = Array.from(sessions.values())
                .find(sess => sess.userId === data.userId);
            
            if (targetSession) {
                io.to(targetSession.socketId).emit('new_message', {
                    message: data.message,
                    operatorId: operators.get(socket.id).id,
                    timestamp: new Date()
                });
                
                console.log(`📤 Message from operator to ${data.userId}: ${data.message}`);
            }
        }
    });

    socket.on('typing', (data) => {
        const session = getSessionByUserId(data.userId);
        if (session && session.operatorId) {
            const operator = Array.from(operators.values())
                .find(op => op.id === session.operatorId);
            
            if (operator) {
                io.to(operator.socketId).emit('user_typing', {
                    userId: data.userId
                });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('🔴 Disconnected:', socket.id);
        
        // Handle operator disconnect
        if (operators.has(socket.id)) {
            const operator = operators.get(socket.id);
            console.log(`❌ Operator ${operator.name} disconnected`);
            
            // Find sessions with this operator
            const affectedSessions = Array.from(sessions.values())
                .filter(sess => sess.operatorId === operator.id);
            
            // Notify users
            affectedSessions.forEach(session => {
                io.to(session.socketId).emit('operator_disconnected');
            });
            
            operators.delete(socket.id);
        }
        
        // Handle user disconnect
        const session = Array.from(sessions.values())
            .find(sess => sess.socketId === socket.id);
        
        if (session) {
            // Notify operator
            if (session.operatorId) {
                const operator = Array.from(operators.values())
                    .find(op => op.id === session.operatorId);
                
                if (operator) {
                    io.to(operator.socketId).emit('user_disconnected', {
                        userId: session.userId
                    });
                }
            }
            
            // Remove from sessions
            sessions.delete(session.socketId);
            
            // Remove from waiting queue if exists
            const queueIndex = waitingQueue.findIndex(item => item.socketId === socket.id);
            if (queueIndex > -1) {
                waitingQueue.splice(queueIndex, 1);
            }
            
            console.log(`❌ User ${session.userId} disconnected`);
        }
    });
});

function getAvailableOperator() {
    const onlineOperators = Array.from(operators.values())
        .filter(op => op.status === 'online');
    
    // Simple round-robin assignment
    return onlineOperators.length > 0 ? onlineOperators[0] : null;
}

function createSession(socketId, userId, operatorId) {
    sessions.set(socketId, {
        socketId: socketId,
        userId: userId,
        operatorId: operatorId,
        startTime: new Date()
    });
}

function getSessionByUserId(userId) {
    return Array.from(sessions.values())
        .find(sess => sess.userId === userId);
}

function assignOperatorToWaitingUser() {
    if (waitingQueue.length === 0) return;
    
    const availableOperator = getAvailableOperator();
    if (!availableOperator) return;
    
    const waitingUser = waitingQueue.shift();
    
    // Create session
    createSession(waitingUser.socketId, waitingUser.userId, availableOperator.id);
    
    // Notify user
    io.to(waitingUser.socketId).emit('operator_assigned', {
        operatorId: availableOperator.id,
        operatorName: availableOperator.name
    });
    
    // Notify operator
    io.to(availableOperator.socketId).emit('new_user', {
        userId: waitingUser.userId,
        socketId: waitingUser.socketId
    });
    
    console.log(`✅ Assigned waiting user ${waitingUser.userId} to operator ${availableOperator.name}`);
}

function checkQueuePeriodically() {
    if (waitingQueue.length === 0) return;
    
    const interval = setInterval(() => {
        if (waitingQueue.length === 0) {
            clearInterval(interval);
            return;
        }
        
        const availableOperator = getAvailableOperator();
        if (availableOperator) {
            assignOperatorToWaitingUser();
        }
    }, 3000); // Check every 3 seconds
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 Chat server running on port ${PORT}`);
    console.log(`📋 Operator dashboard: http://localhost:${PORT}/operator.html`);
});
