const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");

const users = {}; // Simulating a database for simplicity
const sessions = {}; // Store all active sessions
const activeSessions = {};
const SECRET_KEY = "iasg435da12sg433fdg312d2fhsg43dfa5jd4hfkja"; // Use an environment variable for better security
const TOKEN_EXPIRATION = "8h"; // Token valid for 8 hours

const rankNames = [
    "Beginner", "Novice", "Apprentice", "Learner", "Explorer",
    "Scholar", "Thinker", "Student", "Practitioner", "Researcher",
    "Adept", "Analyst", "Expert", "Master", "Mentor",
    "Strategist", "Visionary", "Sage", "Grandmaster", "Legend"
];

// Export the socket handlers as a function
const socketHandlers = (io) => {
    io.on("connection", (socket) => {
        console.log("New client connected:", socket.id);

        // Middleware to authenticate the user via JWT
        socket.use((packet, next) => {
            const token = packet[1]?.token;
            if (token) {
                try {
                    const decoded = jwt.verify(token, SECRET_KEY);
                    socket.userId = decoded.userId;
                    next();
                } catch (error) {
                    console.error("Invalid token:", error.message);
                    next(new Error("Authentication error"));
                }
            } else {
                next();
            }
        });

        // Fetch user profile
        socket.on("getProfile", (callback) => {
            const userId = socket.userId;
            if (userId && users[userId]) {
                callback(users[userId]);
            } else {
                callback(null);
            }
        });

        socket.on("updateProfile", (updatedProfile, callback) => {
            const userId = socket.userId;
            if (!userId || !users[userId]) {
                return callback({ success: false, message: "User not found" });
            }
        
            // Extract new username from the updated profile
            const newUsername = updatedProfile.username?.trim();
        
            // Check if username already exists (excluding the current user)
            const usernameTaken = Object.values(users).some(
                (user) => user.id !== userId && user.username === newUsername
            );
        
            if (usernameTaken) {
                return callback({ success: false, message: "Username is already taken" });
            }
        
            // Update the user profile
            users[userId] = { ...users[userId], ...updatedProfile };
            
            callback({ success: true });
        });

        socket.on("updateUsername", ({ id, username }, callback) => {
            if (!username || !/^[a-zA-Z0-9_]+$/.test(username) || username.length < 3) {
                return callback(false); // Invalid username
            }
        
            // Check if username is already taken
            const isTaken = Object.values(users).some((user) => user.username === username && user.id !== id);
            if (isTaken) {
                return callback(false);
            }
        
            if (users[id]) {
                users[id].username = username;
                callback(true);
            } else {
                callback(false);
            }
        });        

        // Delete user profile
        socket.on("deleteProfile", (callback) => {
            const userId = socket.userId;
            if (userId && users[userId]) {
                delete users[userId];
                callback(true);
            } else {
                callback(false);
            }
        });

        // Login or Signup functionality
        socket.on("loginOrSignup", async ({ email, password, isLogin }, callback) => {
            try {
                const existingUser = Object.values(users).find((user) => user.email === email);

                if (isLogin) {
                    // Login flow
                    if (existingUser) {
                        const isPasswordValid = await bcrypt.compare(password, existingUser.password);
                        if (isPasswordValid) {
                            socket.userId = existingUser.id;

                            // Generate JWT token
                            const token = jwt.sign({ userId: existingUser.id }, SECRET_KEY, {
                                expiresIn: TOKEN_EXPIRATION,
                            });

                            callback({ success: true, user: existingUser, token });
                        } else {
                            callback({ success: false, message: "Invalid password." });
                        }
                    } else {
                        callback({ success: false, message: "User not found." });
                    }
                } else {
                    // Signup flow
                    if (existingUser) {
                        callback({ success: false, message: "Email already in use." });
                    } else {
                        const hashedPassword = await bcrypt.hash(password, 10);
                        const newUser = {
                            id: socket.id,
                            email,
                            password: hashedPassword,
                            username: '',
                            skills: [],
                            talkingLanguages: [],
                            socialLinks: {},
                            sessions: [],
                            connections: [],
                            timeSpent: 0,
                            level: 0,
                            rank: 'Beginner',
                            bio: "",
                            profileImage: "",
                        };
                        users[socket.id] = newUser;
                        socket.userId = socket.id;

                        // Generate JWT token
                        const token = jwt.sign({ userId: socket.id }, SECRET_KEY, {
                            expiresIn: TOKEN_EXPIRATION,
                        });

                        callback({ success: true, user: newUser, token });
                    }
                }
            } catch (error) {
                console.error("Error in loginOrSignup:", error);
                callback({ success: false, message: "An error occurred." });
            }
        });

        // Rejoin functionality
        socket.on("rejoin", ({ token }, callback) => {
            try {
                const decoded = jwt.verify(token, SECRET_KEY);
                const userId = decoded.userId;
        
                if (users[userId]) {
                    socket.userId = userId;
                    callback({ success: true, user: users[userId] });
                } else {
                    console.error(`Rejoin failed: User ID ${userId} not found.`);
                    callback({ success: false, message: "User not found." });
                }
            } catch (error) {
                console.error("Error in rejoin:", error.message);
                callback({ success: false, message: "Invalid or expired token." });
            }
        });

        socket.on("createSession", (sessionData, callback) => {
            try {
                const { name, description, maxUsers, isPrivate, isHostMode } = sessionData;
        
                // Generate a unique 6-digit session ID
                let sessionId;
                do {
                    sessionId = Math.floor(100000 + Math.random() * 900000).toString();
                } while (sessions[sessionId]);
        
                // Determine the username of the session creator
                const creator = users[socket.userId];
                const username = creator?.username || "Guest";
        
                // Create the session
                sessions[sessionId] = {
                    id: sessionId,
                    name,
                    description,
                    maxUsers,
                    isPrivate,
                    isHostMode, // Enable host mode if selected
                    host: socket.userId, // Set the session creator as the host
                    members: [
                        {
                            id: socket.userId,
                            username,
                            joinedAt: new Date().toISOString()
                        },
                    ],
                    code: "# Write your Python code here",
                    createdAt: new Date().toISOString(), // Store the session creation time
                };
        
                // Add the session creator to the room
                socket.join(sessionId);
        
                console.log(`Session created by ${username} at ${sessions[sessionId].createdAt}: ${sessionId}`);
                callback({ success: true, session: sessions[sessionId] });
            } catch (error) {
                console.error("Error creating session:", error.message);
                callback({ success: false, message: "Failed to create session" });
            }
        });        
        
        socket.on("joinSession", ({ sessionId, user }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    return callback({ success: false, message: "Session not found" });
                }
        
                const session = sessions[sessionId];
                const userId = user?.id || socket.userId;
                const username = user?.username?.trim();
        
                // ✅ Prevent users without valid id and username from joining
                if (!userId || !username) {
                    return callback({ success: false, message: "Invalid user. Cannot join session." });
                }
        
                // ✅ Check if the user is banned
                if (session.bannedUsers && session.bannedUsers.has(userId)) {
                    return callback({ success: false, message: "You have been banned from this session." });
                }
        
                // Check if the user is already in the session
                const existingMember = session.members.find(member => member.id === userId);
        
                // ✅ If session is full but the user is already in, allow rejoining
                if (!existingMember && session.members.length >= session.maxUsers) {
                    return callback({ success: false, message: "Session is full" });
                }
        
                // ✅ If the user is not in the session, add them with a join timestamp
                if (!existingMember) {
                    session.members.push({
                        id: userId,
                        username,
                        joinedAt: new Date().toISOString() // ✅ Store correct join time
                    });
                }
        
                // Add the user to the socket room
                socket.join(sessionId);
        
                // Notify all members about the updated user list
                io.to(sessionId).emit(
                    "updateUsers",
                    session.members.map(({ id, username }) => ({ id, username }))
                );
        
                // Send back full session details
                callback({ success: true, session });
        
            } catch (error) {
                console.error("Error joining session:", error.message);
                callback({ success: false, message: "Failed to join session" });
            }
        });
        
        socket.on("leaveSession", ({ sessionId }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    if (typeof callback === "function") {
                        return callback({ success: false, message: "Session not found" });
                    }
                    return;
                }
        
                const session = sessions[sessionId];
                const userId = socket.userId;
        
                if (!userId || !users[userId]) {
                    if (typeof callback === "function") {
                        return callback({ success: false, message: "User not found" });
                    }
                    return;
                }
        
                const user = users[userId];
        
                // Ensure user has session tracking
                if (!user.joinedSessions) user.joinedSessions = {};
        
                const memberData = session.members.find(member => member.id === userId);

                if (!memberData || !memberData.joinedAt) {
                    console.warn(`User ${userId} had no recorded join time for session ${sessionId}`);
                    return callback({ success: false, message: "Join time not recorded" });
                }

                const joinedTime = new Date(memberData.joinedAt);
                const leftTime = new Date();
                const duration = Math.floor((leftTime - joinedTime) / 1000); // Duration in seconds
        
                // Add session details to user's session history
                if (!user.sessions) user.sessions = [];
                user.sessions.push({
                    sessionId,
                    name: session.name,
                    description: session.description,
                    duration,
                    leftAt: leftTime,
                    wasHost: session.host === userId,
                });

                function updateUserLevelAndRank(user) {
                    if (!user || !user.sessions) return;
                
                    // **Calculate total time spent in sessions (in seconds)**
                    user.timeSpent = user.sessions.reduce((total, session) => total + session.duration, 0);
                
                    // **Calculate level: 1 level per 20 minutes (1200 seconds)**
                    user.level = Math.floor(user.timeSpent / 1200) + 1; // Ensures level starts at 1
                
                    // **Determine rank: Every 5 levels corresponds to a new rank**
                    const rankIndex = Math.min(Math.floor(user.level / 5), rankNames.length - 1);
                    user.rank = rankNames[rankIndex];
                }
        
                // **Update user level and rank**
                updateUserLevelAndRank(user);
        
                // Remove user from session members
                session.members = session.members.filter(member => member.id !== userId);
        
                // Delete session if empty
                if (session.members.length === 0) {
                    delete sessions[sessionId];
                } else {
                    // Notify remaining members about updated user list
                    io.to(sessionId).emit(
                        "updateUsers",
                        session.members.map(({ id, username, handRaised }) => ({ id, username, handRaised }))
                    );
                }
        
                // Remove the user from the room
                socket.leave(sessionId);
        
                if (typeof callback === "function") {
                    callback({ success: true });
                }
            } catch (error) {
                console.error("Error leaving session:", error.message);
                if (typeof callback === "function") {
                    callback({ success: false, message: "Failed to leave session" });
                }
            }
        });

        socket.on("checkSession", (sessionId, callback) => {
            try {
                // Check if the session exists
                if (sessions[sessionId]) {
                    // If the session exists, return true to the frontend
                    callback({ success: true, message: "Session exists", sessionId });
                } else {
                    // If the session doesn't exist, return false
                    callback({ success: false, message: "Session not found" });
                }
            } catch (error) {
                console.error("Error checking session:", error.message);
                callback({ success: false, message: "Failed to check session" });
            }
        });

        socket.on("banUser", ({ sessionId, targetUserId }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    return callback({ success: false, message: "Session not found" });
                }
        
                const session = sessions[sessionId];
        
                // Ensure only the host can ban users
                if (socket.userId !== session.host) {
                    return callback({ success: false, message: "Only the host can ban users" });
                }
        
                // Prevent the host from banning themselves
                if (socket.userId === targetUserId) {
                    return callback({ success: false, message: "You cannot ban yourself!" });
                }
        
                // Initialize bannedUsers array if not present
                if (!session.bannedUsers) {
                    session.bannedUsers = new Set();
                }
        
                // Add the user to the banned list
                session.bannedUsers.add(targetUserId);
        
                // Remove the banned user from the session
                session.members = session.members.filter(member => member.id !== targetUserId);
                io.to(sessionId).emit("updateUsers", session.members);
        
                // Disconnect the banned user from the session
                io.to(targetUserId).emit("bannedFromSession", { message: "You have been banned from this session." });
                io.sockets.sockets.get(targetUserId)?.leave(sessionId);
        
                console.log(`User ${targetUserId} was banned from session ${sessionId}`);
        
                callback({ success: true, message: "User banned successfully." });
        
            } catch (error) {
                console.error("Error banning user:", error.message);
                callback({ success: false, message: "Failed to ban user." });
            }
        });

        socket.on("updateCode", ({ sessionId, code }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    if (typeof callback === "function") {
                        return callback({ success: false, message: "Session not found" });
                    }
                    return;
                }
        
                // Update session code
                sessions[sessionId].code = code;
        
                // Broadcast updated code to other members (excluding the sender)
                socket.to(sessionId).emit("updateCode", { code, sender: socket.id });
        
                if (typeof callback === "function") {
                    callback({ success: true });
                }
            } catch (error) {
                console.error("Error updating code:", error.message);
                if (typeof callback === "function") {
                    callback({ success: false, message: "Failed to update code" });
                }
            }
        });

        socket.on("raiseHand", ({ sessionId }, callback) => {
            if (!sessions[sessionId]) {
                if (typeof callback === "function") {
                    return callback({ success: false, message: "Session not found" });
                }
                return;
            }
        
            const session = sessions[sessionId];
            const userIndex = session.members.findIndex(member => member.id === socket.userId);

            // Find the user in the session
            const user = session.members.find(member => member.id === socket.userId);

            if (user) {
                io.to(sessionId).emit("raiseHandNotification", { username: user.username });
            }
        
            if (userIndex !== -1) {
                session.members[userIndex].handRaised = !session.members[userIndex].handRaised; // Toggle hand state
            }
        
            // Notify all users in the session about the update
            io.to(sessionId).emit("updateUsers", session.members);
        
            if (typeof callback === "function") {
                callback({ success: true });
            }
        });        

        socket.on("runCodeInteractive", ({ sessionId }, callback) => {
            try {
        
                if (!sessions[sessionId]) {
                    console.warn(`[runCodeInteractive] Session not found for sessionId: ${sessionId}`);
                    return callback({ success: false, message: "Session not found" });
                }
        
                const { code } = sessions[sessionId];
                if (!code) {
                    console.warn(`[runCodeInteractive] No code found for sessionId: ${sessionId}`);
                    return callback({ success: false, message: "No code to run" });
                }
        
                const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "python-exec-"));
                const scriptPath = path.join(tempDir, "script.py");
                fs.writeFileSync(scriptPath, code);
        
                const pythonProcess = spawn("python", [scriptPath], {
                    cwd: tempDir,
                    stdio: ["pipe", "pipe", "pipe"], // stdin, stdout, stderr
                });
        
                activeSessions[sessionId] = pythonProcess; // Store process reference
        
                // Forward stdout (terminal output) to frontend
                pythonProcess.stdout.on("data", (data) => {
                    const output = data.toString();
                    io.to(sessionId).emit("terminalData", { data: output }); // Send raw terminal data
                });
        
                // Forward stderr (error messages) to frontend
                pythonProcess.stderr.on("data", (data) => {
                    const error = data.toString();
                    io.to(sessionId).emit("terminalData", { data: error });
                });
        
                pythonProcess.on("close", (code) => {
                    fs.rmSync(tempDir, { recursive: true, force: true });
                    delete activeSessions[sessionId];
        
                    io.to(sessionId).emit("terminalData", { data: `\nProcess exited with code ${code}\n` });
                });
        
                callback({ success: true });
            } catch (error) {
                console.error("[runCodeInteractive] Error running code interactively:", error);
                callback({ success: false, message: "Failed to run interactive code" });
            }
        });
        
        // Handle user input and send it to the running Python process
        socket.on("sendUserInput", ({ sessionId, userInput }) => {
            console.log(`[sendUserInput] Received input for sessionId: ${sessionId} -> "${userInput}"`);
        
            if (!activeSessions[sessionId]) {
                console.warn(`[sendUserInput] No active process for sessionId: ${sessionId}`);
                return io.to(sessionId).emit("terminalData", { data: "Error: No active process\n" });
            }
        
            const pythonProcess = activeSessions[sessionId];
            pythonProcess.stdin.write(userInput + "\n");
        });

        socket.on("listSessions", (callback) => {
            try {
              const publicSessions = Object.values(sessions).filter((session) => !session.isPrivate);
              callback({ success: true, sessions: publicSessions });
            } catch (error) {
              console.error("Error listing sessions:", error.message);
              callback({ success: false, message: "Failed to list sessions" });
            }
        });

        socket.on("searchUsers", ({ query }, callback) => {
            try {
                if (!query || query.trim() === "") {
                    return callback({ success: false, message: "Invalid search query." });
                }
        
                // Find users whose username matches or is similar (case-insensitive)
                const results = Object.values(users).filter(user =>
                    user.username.toLowerCase().includes(query.toLowerCase())
                );
        
                callback({ success: true, users: results });
            } catch (error) {
                console.error("Error searching users:", error.message);
                callback({ success: false, message: "Failed to search users." });
            }
        });

        socket.on("addConnection", ({ userId, targetUserId }, callback) => {
            try {
                if (!users[userId] || !users[targetUserId]) {
                    return callback({ success: false, message: "User not found." });
                }
        
                const user = users[userId];
                const targetUser = users[targetUserId];
        
                // Prevent duplicates
                if (user.connections.some(conn => conn.id === targetUserId)) {
                    return callback({ success: false, message: "Already connected." });
                }
        
                // Store connection info (excluding email and password)
                const targetUserData = {
                    id: targetUser.id,
                    username: targetUser.username,
                    profileImage: targetUser.profileImage,
                    level: targetUser.level,
                    rank: targetUser.rank,
                    skills: targetUser.skills,
                    talkingLanguages: targetUser.talkingLanguages,
                };
        
                user.connections.push(targetUserData);
                callback({ success: true });
            } catch (error) {
                console.error("Error adding connection:", error.message);
                callback({ success: false, message: "Failed to add connection." });
            }
        });

        socket.on("removeConnection", ({ userId, targetUserId }, callback) => {
            try {
                if (!users[userId] || !users[targetUserId]) {
                    return callback({ success: false, message: "User not found." });
                }
        
                const user = users[userId];
        
                // Find and remove the connection
                const initialLength = user.connections.length;
                user.connections = user.connections.filter(conn => conn.id !== targetUserId);
        
                // If no change occurred, user wasn't in the connections list
                if (user.connections.length === initialLength) {
                    return callback({ success: false, message: "User is not in your connections." });
                }
        
                callback({ success: true });
            } catch (error) {
                console.error("Error removing connection:", error.message);
                callback({ success: false, message: "Failed to remove connection." });
            }
        });

        socket.on("disconnect", () => {
            console.log("Client disconnected:", socket.id);
        });
    });
};

module.exports = socketHandlers;
