const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const socketHandlers = require('./sockets/socket');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Add middleware to parse JSON bodies
app.use(express.json());

// Serve the static files from the React app build folder
app.use(express.static(path.join(__dirname, './my-app/dist')));

// Route all other requests to the React app's index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, './my-app/dist', 'index.html'));
});

// Initialize Socket.IO handlers
socketHandlers(io);

// Start the server
const PORT = 5000;
server.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});
