const express = require('express'); 
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const cors = require('cors');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const morgan = require('morgan');
const socketHandlers = require('./sockets/socket');

require('dotenv').config();

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { 
        origin: process.env.ALLOWED_ORIGIN,
        methods: ["GET", "POST"],
        credentials: true
    },
    maxHttpBufferSize: 4 * 1024 * 1024 // Set max payload size to 4MB
});

// --- 🔒 SECURITY ENHANCEMENTS --- //

// ✅ Helmet Security Headers
app.use(helmet({
  contentSecurityPolicy: {
      directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'", "trusted-cdn.com"], 
          objectSrc: ["'none'"], 
          upgradeInsecureRequests: [],
          imgSrc: ["'self'", "https://res.cloudinary.com", "data:"], // ✅ Allow Base64 Images
      }
  },
  referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  frameguard: { action: 'deny' }, // Prevents clickjacking
  hidePoweredBy: true, // Hides Express version info
  xssFilter: true, // Prevents cross-site scripting attacks
}));

// ✅ Rate Limiting (DDoS Protection)
const limiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 minutes
    max: 100, // Limit each IP to 100 requests per windowMs
    message: "Too many requests, please try again later.",
    standardHeaders: true,
    legacyHeaders: false
});
app.use(limiter);

// ✅ CORS Configuration
app.use(cors({
    origin: process.env.ALLOWED_ORIGIN,
    methods: ["GET", "POST"],
    credentials: true
}));

// ✅ Secure Session Management
app.use(cookieParser());
app.use(session({
    secret: process.env.SECRET_KEY,
    resave: false,
    saveUninitialized: false,
    cookie: {
        httpOnly: true, // Prevents XSS attacks
        secure: process.env.NODE_ENV === 'production', // Enable only in production
        sameSite: 'strict'
    }
}));

// ✅ Logging & Monitoring
app.use(morgan('combined')); // Logs requests

// ✅ JSON & Input Sanitization
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ✅ Serve Static Files Securely
app.use(express.static(path.join(__dirname, '/my-app/dist'), {
    setHeaders: (res, filePath) => {
        if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store'); // Prevents caching of sensitive pages
        }
    }
}));

// ✅ Route Protection - Only Serve Files
app.get('*', (req, res) => {
    res.sendFile(path.join(__dirname, '/my-app/dist', 'index.html'));
});

// ✅ Initialize Socket.IO Handlers
socketHandlers(io);

// ✅ Start Server
const PORT = process.env.PORT;
server.listen(PORT, () => {
    console.log(`🚀 Server is running securely on http://localhost:${PORT}`);
});
