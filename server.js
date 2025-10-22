// server.js
const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const cors = require('cors');

const app = express();
const server = http.createServer(app);
const io = socketIo(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

app.use(cors());
app.use(express.json());

// Store connected operators
const operators = new Map();
// Store active chat sessions
const sessions = new Map();

io.on('connection', (socket) => {
    console.log('User connected:', socket.id);

    socket.on('register_operator', (data) => {
        operators.set(socket.id, {
            id: data.operatorId,
            name: data.name,
            socketId: socket.id
        });
        console.log(`Operator ${data.name} registered`);
    });

    socket.on('register_user', (data) => {
        sessions.set(socket.id, {
            userId: data.userId,
            socketId: socket.id,
            operatorId: null
        });
        
        // Assign to available operator
        assignOperator(socket.id);
    });

    socket.on('send_message', (data) => {
        const session = sessions.get(socket.id);
        if (session && session.operatorId) {
            // Send to operator
            const operatorSocket = Array.from(operators.values())
                .find(op => op.id === session.operatorId);
            
            if (operatorSocket) {
                io.to(operatorSocket.socketId).emit('new_message', {
                    message: data.message,
                    userId: session.userId,
                    timestamp: new Date()
                });
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
            }
        }
    });

    socket.on('typing', (data) => {
        // Handle typing indicators
        const session = sessions.get(socket.id);
        if (session && session.operatorId) {
            const operatorSocket = Array.from(operators.values())
                .find(op => op.id === session.operatorId);
            
            if (operatorSocket) {
                io.to(operatorSocket.socketId).emit('user_typing', {
                    userId: session.userId
                });
            }
        }
    });

    socket.on('disconnect', () => {
        console.log('User disconnected:', socket.id);
        
        if (operators.has(socket.id)) {
            operators.delete(socket.id);
        }
        
        if (sessions.has(socket.id)) {
            const session = sessions.get(socket.id);
            // Notify operator if user disconnects
            if (session.operatorId) {
                const operatorSocket = Array.from(operators.values())
                    .find(op => op.id === session.operatorId);
                
                if (operatorSocket) {
                    io.to(operatorSocket.socketId).emit('user_disconnected', {
                        userId: session.userId
                    });
                }
            }
            sessions.delete(socket.id);
        }
    });
});

function assignOperator(userSocketId) {
    const availableOperators = Array.from(operators.values());
    if (availableOperators.length > 0) {
        const operator = availableOperators[0]; // Simple assignment logic
        const session = sessions.get(userSocketId);
        
        if (session) {
            session.operatorId = operator.id;
            
            // Notify operator
            io.to(operator.socketId).emit('new_user', {
                userId: session.userId
            });
            
            // Notify user
            io.to(userSocketId).emit('operator_assigned', {
                operatorId: operator.id,
                operatorName: operator.name
            });
        }
    }
}

const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
    console.log(`Chat server running on port ${PORT}`);
});
