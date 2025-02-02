const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");
const os = require("os");
const { v2: cloudinary } = require("cloudinary");

// Load environment variables
require('dotenv').config();

// Cloudinary Configuration
cloudinary.config({ 
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME, 
    api_key: process.env.CLOUDINARY_API_KEY, 
    api_secret: process.env.CLOUDINARY_API_SECRET
});

const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL, 
  process.env.SUPABASE_SERVICE_ROLE_KEY
);


const sessions = {}; // Store all active sessions
const activeSessions = {};
const SECRET_KEY = process.env.SECRET_KEY; // Use environment variable for better security
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
                    socket.emit("authError", "Authentication failed: Invalid or expired token.");
                    next(new Error("Authentication error"));
                }
            } else {
                next();
            }
        });

        // 🔹 REJOIN FUNCTION (Uses DB instead of Supabase Auth)
        socket.on("rejoin", async ({ token }, callback) => {
            try {
                const decoded = jwt.verify(token, SECRET_KEY);
                const userId = decoded.userId;

                // Fetch user from Supabase
                const { data: user, error } = await supabase
                    .from("users")
                    .select("*")
                    .eq("id", userId)
                    .single();

                if (error || !user) {
                    console.error(`Rejoin failed: User ID ${userId} not found.`);
                    return callback({ success: false, message: "User not found." });
                }

                socket.userId = userId;
                callback({ success: true, user });
            } catch (error) {
                console.error("Error in rejoin:", error.message);
                callback({ success: false, message: "Invalid or expired token." });
            }
        });

        // 🔹 LOGIN OR SIGNUP FUNCTION (Handles Auth Manually)
        socket.on("loginOrSignup", async ({ email, password, isLogin }, callback) => {
            try {
                // Check if user exists
                const { data: existingUser, error: fetchError } = await supabase
                    .from("users")
                    .select("*")
                    .eq("email", email)
                    .single();
        
                if (fetchError && fetchError.code !== "PGRST116") { // Ignore "no rows found" error
                    return callback({ success: false, message: "Database error." });
                }
        
                if (isLogin) {
                    // 🔹 LOGIN FLOW
                    if (existingUser) {
                        // Validate password with bcrypt
                        const isPasswordValid = await bcrypt.compare(password, existingUser.password);
                        if (!isPasswordValid) {
                            return callback({ success: false, message: "Invalid credentials." });
                        }
        
                        socket.userId = existingUser.id;
        
                        // Generate JWT token
                        const token = jwt.sign({ userId: existingUser.id }, SECRET_KEY, {
                            expiresIn: TOKEN_EXPIRATION,
                        });
        
                        // Fetch the full user data after login
                        const { data: fullUser, error: userError } = await supabase
                            .from("users")
                            .select("*")
                            .eq("id", existingUser.id)
                            .single();
        
                        if (userError || !fullUser) {
                            return callback({ success: false, message: "Failed to retrieve user data." });
                        }
        
                        return callback({ success: true, user: fullUser, token });
                    } else {
                        return callback({ success: false, message: "User not found." });
                    }
                } else {
                    // 🔹 SIGNUP FLOW
                    if (existingUser) {
                        return callback({ success: false, message: "Email already in use." });
                    }
        
                    // Hash password before saving
                    const hashedPassword = await bcrypt.hash(password, 10);
        
                    // Create new user
                    const newUser = {
                        id: crypto.randomUUID(), // Generate UUID manually
                        email,
                        password: hashedPassword, // Store the hashed password
                        username: "",
                        skills: [],
                        talkingLanguages: [],
                        socialLinks: {},
                        sessions: [],
                        connections: [],
                        requests: [],
                        timeSpent: 0,
                        level: 1,
                        rank: "Beginner",
                        bio: "",
                        profileImage: "",
                    };
        
                    const { error: insertError } = await supabase.from("users").insert([newUser]);
                    if (insertError) {
                        return callback({ success: false, message: "Failed to save user data." });
                    }
        
                    socket.userId = newUser.id;
        
                    // Generate JWT token
                    const token = jwt.sign({ userId: newUser.id }, SECRET_KEY, {
                        expiresIn: TOKEN_EXPIRATION,
                    });
        
                    // Fetch full user data after signup
                    const { data: fullUser, error: fetchUserError } = await supabase
                        .from("users")
                        .select("*")
                        .eq("id", newUser.id)
                        .single();
        
                    if (fetchUserError || !fullUser) {
                        return callback({ success: false, message: "Failed to retrieve user data." });
                    }
        
                    return callback({ success: true, user: fullUser, token });
                }
            } catch (error) {
                console.error("Error in loginOrSignup:", error);
                callback({ success: false, message: "An error occurred." });
            }
        });

        // Fetch user profile from Supabase
        socket.on("getProfile", async (callback) => {
            const userId = socket.userId;
            if (!userId) return callback(null);

            try {
                // Fetch user from Supabase
                const { data: users, error } = await supabase
                    .from("users")
                    .select("*")
                    .eq("id", userId);

                if (error) {
                    console.error("Error fetching profile:", error.message);
                    return callback(null);
                }

                // Handle case where no user or multiple users are found
                if (users.length === 0) {
                    console.error("No user found for the given ID");
                    return callback(null); // No user found
                }

                if (users.length > 1) {
                    console.error("Multiple users found for the given ID");
                    return callback(null); // Multiple users found, which shouldn't happen
                }

                // If exactly one user is found
                callback(users[0]);
            } catch (err) {
                console.error("Unexpected error in getProfile:", err.message);
                callback(null);
            }
        });

        // Update user profile in Supabase
        socket.on("updateProfile", async (updatedProfile, callback) => {
            const userId = socket.userId;
            if (!userId) return callback({ success: false, message: "User not found" });

            try {
                // **🔹 Check for username uniqueness in Supabase**
                if (updatedProfile.username) {
                    const { data: existingUser, error: usernameError } = await supabase
                        .from("users")
                        .select("id")
                        .eq("username", updatedProfile.username)
                        .neq("id", userId)
                        .single();

                    if (existingUser) {
                        return callback({ success: false, message: "Username is already taken" });
                    }
                }

                // **🔹 Handle Image Upload if Provided**
                if (updatedProfile.profileImage && updatedProfile.profileImage.startsWith("data:image")) {
                    const imageBase64 = updatedProfile.profileImage;

                    // **🔹 Upload to Cloudinary**
                    const uploadResult = await cloudinary.uploader.upload(imageBase64, {
                        folder: "user_profiles",
                        transformation: [{ width: 300, height: 300, crop: "limit" }], // Resize for optimization
                        resource_type: "image"
                    });

                    if (!uploadResult || !uploadResult.secure_url) {
                        return callback({ success: false, message: "Image upload failed" });
                    }

                    updatedProfile.profileImage = uploadResult.secure_url; // Store Cloudinary URL
                }

                // **🔹 Update User Profile in Supabase**
                const { error: updateError } = await supabase
                    .from("users")
                    .update(updatedProfile)
                    .eq("id", userId);

                if (updateError) {
                    console.error("Profile update error:", updateError.message);
                    return callback({ success: false, message: "Failed to update profile" });
                }

                callback({ success: true, profileImage: updatedProfile.profileImage });
            } catch (error) {
                console.error("Error updating profile:", error.message);
                callback({ success: false, message: "Failed to update profile" });
            }
        });

        socket.on("updateUsername", async ({ id, username }, callback) => {
            if (!username || !/^[a-zA-Z0-9_]+$/.test(username) || username.length < 3) {
                return callback({ success: false, message: "Invalid username format." });
            }
        
            try {
                // ✅ Check if the username is already taken (excluding the current user)
                const { data: existingUsers, error: usernameError } = await supabase
                    .from("users")
                    .select("id")
                    .eq("username", username)
                    .neq("id", id);  // Exclude the current user
        
                if (usernameError) {
                    console.error("Error checking username:", usernameError.message);
                    return callback({ success: false, message: "Database error." });
                }
        
                // ✅ If any other user has this username, return an error
                if (existingUsers && existingUsers.length > 0) {
                    return callback({ success: false, message: "Username is already taken. Try another." });
                }
        
                // ✅ Update the username in Supabase
                const { error: updateError } = await supabase
                    .from("users")
                    .update({ username })
                    .eq("id", id);
        
                if (updateError) {
                    console.error("Username update error:", updateError.message);
                    return callback({ success: false, message: "Failed to update username." });
                }
        
                // ✅ Success - return updated username
                callback({ success: true, username });
            } catch (error) {
                console.error("Error updating username:", error.message);
                callback({ success: false, message: "An error occurred." });
            }
        });

        // Delete user profile from Supabase
        socket.on("deleteProfile", async (callback) => {
            const userId = socket.userId;
            if (!userId) return callback(false);

            try {
                const { error } = await supabase
                    .from("users")
                    .delete()
                    .eq("id", userId);

                if (error) {
                    console.error("Error deleting user:", error.message);
                    return callback(false);
                }

                callback(true);
            } catch (err) {
                console.error("Unexpected error in deleteProfile:", err.message);
                callback(false);
            }
        });

        // 🔹 Create a session
        socket.on("createSession", async (sessionData, callback) => {
            try {
                const { name, description, maxUsers, isPrivate, isHostMode } = sessionData;

                // Generate a unique 6-digit session ID
                let sessionId;
                do {
                    sessionId = Math.floor(100000 + Math.random() * 900000).toString();
                } while (sessions[sessionId]);

                // Fetch the user from Supabase
                const { data: user, error } = await supabase
                    .from("users")
                    .select("id, username, profileImage")
                    .eq("id", socket.userId)
                    .single();

                if (error || !user) {
                    return callback({ success: false, message: "User not found. Cannot create session." });
                }

                const username = user.username || "Guest";
                const profileImage = user.profileImage || "";

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
                            profileImage,
                            joinedAt: new Date().toISOString(),
                        },
                    ],
                    code: "# Write your Python code here",
                    chat: [],
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

        // 🔹 Join session (fetch user details from Supabase)
        socket.on("joinSession", async ({ sessionId }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    return callback({ success: false, message: "Session not found" });
                }

                const session = sessions[sessionId];
                const userId = socket.userId;

                // Fetch user from Supabase
                const { data: user, error } = await supabase
                    .from("users")
                    .select("id, username, profileImage")
                    .eq("id", userId)
                    .single();

                if (error || !user) {
                    return callback({ success: false, message: "User not found. Cannot join session." });
                }

                const username = user.username.trim();

                // ✅ Prevent users without valid id and username from joining
                if (!userId || !username) {
                    return callback({ success: false, message: "Invalid user. Cannot join session." });
                }

                // ✅ Check if the user is banned
                if (session.bannedUsers && session.bannedUsers.has(userId)) {
                    return callback({ success: false, message: "You have been banned from this session." });
                }

                // Check if the user is already in the session
                let existingMember = session.members.find(member => member.id === userId);

                // ✅ If session is full but the user is already in, allow rejoining
                if (!existingMember && session.members.length >= session.maxUsers) {
                    return callback({ success: false, message: "Session is full" });
                }

                // ✅ If the user is not in the session, add them with edit permissions
                if (!existingMember) {
                    const isHost = session.host === userId;
                    const canEdit = !session.isHostMode || isHost; // If host mode is OFF, all can edit, otherwise only host can edit

                    existingMember = {
                        id: userId,
                        username,
                        profileImage: user.profileImage,
                        joinedAt: new Date().toISOString(),
                        edit: canEdit, // ✅ Set edit permissions correctly
                    };

                    session.members.push(existingMember);
                } else {
                    // ✅ Update edit permission if they were already in
                    existingMember.edit = !session.isHostMode || session.host === userId;
                }

                // Add the user to the socket room
                socket.join(sessionId);

                // Notify all members about the updated user list
                io.to(sessionId).emit("updateUsers", session.members);

                socket.emit("updateChat", session.chat);

                // Send back full session details
                callback({ success: true, session });

            } catch (error) {
                console.error("Error joining session:", error.message);
                callback({ success: false, message: "Failed to join session" });
            }
        });

        // 🔹 Ban a user (ensure they exist in Supabase)
        socket.on("banUser", async ({ sessionId, targetUserId }, callback) => {
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

                // Fetch target user from Supabase
                const { data: targetUser, error } = await supabase
                    .from("users")
                    .select("id")
                    .eq("id", targetUserId)
                    .single();

                if (error || !targetUser) {
                    return callback({ success: false, message: "User not found in database" });
                }

                // Initialize bannedUsers set if not present
                if (!session.bannedUsers) {
                    session.bannedUsers = new Set();
                }

                // Add the user to the banned list
                session.bannedUsers.add(targetUserId);

                // Remove the banned user from the session members
                session.members = session.members.filter(member => member.id !== targetUserId);
                io.to(sessionId).emit("updateUsers", session.members);

                // ✅ Find the banned user's socket connection
                const bannedSocket = [...io.sockets.sockets.values()].find(
                    (s) => s.userId === targetUserId
                );

                if (bannedSocket) {
                    // ✅ Notify and disconnect the banned user
                    bannedSocket.emit("bannedFromSession", { sessionId, message: "You have been banned from this session." });
                    bannedSocket.leave(sessionId);
                }

                console.log(`User ${targetUserId} was banned from session ${sessionId}`);

                callback({ success: true, message: "User banned successfully." });
            } catch (error) {
                console.error("Error banning user:", error.message);
                callback({ success: false, message: "Failed to ban user." });
            }
        });

        // 🔹 Toggle edit permission for a user (host only)
        socket.on("toggleEditPermission", async ({ sessionId, targetUserId }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    return callback({ success: false, message: "Session not found" });
                }

                const session = sessions[sessionId];

                // Ensure only the host can modify edit permissions
                if (socket.userId !== session.host) {
                    return callback({ success: false, message: "Only the host can modify edit permissions" });
                }

                // Prevent host from modifying their own edit permission
                if (socket.userId === targetUserId) {
                    return callback({ success: false, message: "You cannot modify your own edit permission!" });
                }

                // Find the target user in session members
                const targetMember = session.members.find(member => member.id === targetUserId);

                if (!targetMember) {
                    return callback({ success: false, message: "User not found in session" });
                }

                // Toggle edit permission
                targetMember.edit = !targetMember.edit;

                // Emit updated users list
                io.to(sessionId).emit("updateUsers", session.members);

                console.log(`User ${targetUserId} edit permission changed to: ${targetMember.edit}`);

                callback({ success: true, message: `User can edit: ${targetMember.edit}` });
            } catch (error) {
                console.error("Error toggling edit permission:", error.message);
                callback({ success: false, message: "Failed to toggle edit permission." });
            }
        });

        // 🔹 Update cursor & selection positions
        socket.on("updateCursorSelection", ({ sessionId, cursor, selection }) => {
            if (!sessions[sessionId]) return;

            // ✅ Store cursor & selection positions
            sessions[sessionId].cursors = sessions[sessionId].cursors || {};
            sessions[sessionId].cursors[socket.id] = { cursor, selection };

            // ✅ Broadcast updates to other members (excluding sender)
            socket.to(sessionId).emit("updateCursorSelection", { 
                cursor, 
                selection, 
                sender: socket.id
            });
        });
        
        // 🔹 Leave session and update Supabase users
        socket.on("leaveSession", async ({ sessionId }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    return callback({ success: false, message: "Session not found" });
                }

                const session = sessions[sessionId];
                const userId = socket.userId;

                // Fetch user from Supabase
                const { data: user, error } = await supabase
                    .from("users")
                    .select("id, username, sessions, timeSpent, level, rank")
                    .eq("id", userId)
                    .single();

                if (error || !user) {
                    return callback({ success: false, message: "User not found" });
                }

                const memberData = session.members.find(member => member.id === userId);
                if (!memberData || !memberData.joinedAt) {
                    console.warn(`User ${userId} had no recorded join time for session ${sessionId}`);
                    return callback({ success: false, message: "Join time not recorded" });
                }

                const joinedTime = new Date(memberData.joinedAt);
                const leftTime = new Date();
                const duration = Math.floor((leftTime - joinedTime) / 1000); // Duration in seconds

                // Update session history for the user
                const updatedSessions = user.sessions || [];
                updatedSessions.push({
                    sessionId,
                    name: session.name,
                    description: session.description,
                    duration,
                    leftAt: leftTime,
                    wasHost: session.host === userId,
                });

                // 🔹 Update user level and rank
                const totalTimeSpent = updatedSessions.reduce((total, s) => total + s.duration, 0);
                const level = Math.floor(totalTimeSpent / 1200) + 1; // 1 level per 20 minutes
                const rankIndex = Math.min(Math.floor(level / 5), rankNames.length - 1);
                const rank = rankNames[rankIndex];

                // Update user in Supabase
                await supabase
                    .from("users")
                    .update({ sessions: updatedSessions, timeSpent: totalTimeSpent, level, rank })
                    .eq("id", userId);

                // Remove user from session members
                session.members = session.members.filter(member => member.id !== userId);

                // If the host leaves, delete the session
                if (session.host === userId) {
                    delete sessions[sessionId];
                    io.to(sessionId).emit("deletedSession", { sessionId, message: "The session has been deleted because the host left." });
                } else {
                    io.to(sessionId).emit(
                        "updateUsers",
                        session.members.map(({ id, username, handRaised }) => ({ id, username, handRaised }))
                    );
                }

                // Remove the user from the room
                socket.leave(sessionId);

                callback({ success: true });
            } catch (error) {
                console.error("Error leaving session:", error.message);
                callback({ success: false, message: "Failed to leave session" });
            }
        });

        // 🔹 Check if session exists
        socket.on("checkSession", (sessionId, callback) => {
            try {
                if (sessions[sessionId]) {
                    callback({ success: true, message: "Session exists", sessionId });
                } else {
                    callback({ success: false, message: "Session not found" });
                }
            } catch (error) {
                console.error("Error checking session:", error.message);
                callback({ success: false, message: "Failed to check session" });
            }
        });

        // 🔹 Update Code in Session
        socket.on("updateCode", ({ sessionId, code }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    return callback({ success: false, message: "Session not found" });
                }

                // Update session code
                sessions[sessionId].code = code;

                // Broadcast updated code to other members (excluding the sender)
                socket.to(sessionId).emit("updateCode", { code, sender: socket.id });

                callback({ success: true });
            } catch (error) {
                console.error("Error updating code:", error.message);
                callback({ success: false, message: "Failed to update code" });
            }
        });

        // 🔹 Raise Hand Functionality
        socket.on("raiseHand", async ({ sessionId }, callback) => {
            if (!sessions[sessionId]) {
                if (callback) callback({ success: false, message: "Session not found" });
                return;
            }

            const session = sessions[sessionId];
            const userId = socket.userId;

            // Fetch user from Supabase
            const { data: user, error } = await supabase
                .from("users")
                .select("id, username")
                .eq("id", userId)
                .single();

            if (error || !user) {
                if (callback) callback({ success: false, message: "User not found" });
                return;
            }

            const userIndex = session.members.findIndex(member => member.id === userId);

            // Notify all users when hand is raised
            io.to(sessionId).emit("raiseHandNotification", { username: user.username });

            if (userIndex !== -1) {
                session.members[userIndex].handRaised = !session.members[userIndex].handRaised;
            }

            io.to(sessionId).emit("updateUsers", session.members);
            
            // ✅ Check if callback exists before calling it
            if (callback) {
                callback({ success: true });
            }
        });

        // 🔹 Run Python Code in Session
        socket.on("runCodeInteractive", ({ sessionId }, callback) => {
            try {
                if (!sessions[sessionId]) {
                    return callback({ success: false, message: "Session not found" });
                }

                const { code } = sessions[sessionId];
                if (!code) {
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
                    io.to(sessionId).emit("terminalData", { data: data.toString() });
                });

                // Forward stderr (error messages) to frontend
                pythonProcess.stderr.on("data", (data) => {
                    io.to(sessionId).emit("terminalData", { data: data.toString() });
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

        // 🔹 Handle User Input for Running Code
        socket.on("sendUserInput", ({ sessionId, userInput }) => {
            if (!activeSessions[sessionId]) {
                return io.to(sessionId).emit("terminalData", { data: "Error: No active process\n" });
            }

            const pythonProcess = activeSessions[sessionId];
            pythonProcess.stdin.write(userInput + "\n");
        });

        // 🔹 List All Public Sessions
        socket.on("listSessions", (callback) => {
            try {
                const publicSessions = Object.values(sessions).filter((session) => !session.isPrivate);
                callback({ success: true, sessions: publicSessions });
            } catch (error) {
                console.error("Error listing sessions:", error.message);
                callback({ success: false, message: "Failed to list sessions" });
            }
        });

        // 🔹 Search Users in Supabase
        socket.on("searchUsers", async ({ query }, callback) => {
            try {
                if (!query || query.trim() === "") {
                    return callback({ success: false, message: "Invalid search query." });
                }

                // Search users in Supabase
                const { data: users, error } = await supabase
                    .from("users")
                    .select("*")
                    .ilike("username", `%${query}%`);

                if (error) {
                    console.error("Error searching users:", error.message);
                    return callback({ success: false, message: "Failed to search users." });
                }

                callback({ success: true, users });
            } catch (error) {
                console.error("Error searching users:", error.message);
                callback({ success: false, message: "Failed to search users." });
            }
        });

        // 📌 Send a connection request instead of directly adding a connection
        socket.on("sendConnectionRequest", async ({ userId, targetUserId }, callback) => {
            try {
                // Fetch users from Supabase
                const { data: user, error: userError } = await supabase
                    .from("users")
                    .select("id, connections, requests")
                    .eq("id", userId)
                    .single();

                const { data: targetUser, error: targetError } = await supabase
                    .from("users")
                    .select("id, connections, requests")
                    .eq("id", targetUserId)
                    .single();

                if (userError || targetError || !user || !targetUser) {
                    return callback({ success: false, message: "User not found." });
                }

                // ✅ Prevent sending request if already connected
                if (user.connections.includes(targetUserId)) {
                    return callback({ success: false, message: "You are already connected." });
                }

                // ✅ Prevent duplicate requests
                if (targetUser.requests.includes(userId)) {
                    return callback({ success: false, message: "Request already sent." });
                }

                // ✅ Store the request
                const updatedRequests = [...targetUser.requests, userId];

                // Update Supabase
                await supabase
                    .from("users")
                    .update({ requests: updatedRequests })
                    .eq("id", targetUserId);

                // Notify target user of new request
                io.to(targetUserId).emit("updateConnectionRequests", updatedRequests);

                callback({ success: true });
            } catch (error) {
                console.error("Error sending connection request:", error.message);
                callback({ success: false, message: "Failed to send request." });
            }
        });

        // 📌 Retrieve connection requests for the user
        socket.on("getConnectionRequests", async ({ userId }, callback) => {
            try {
                // Fetch user from Supabase
                const { data: user, error } = await supabase
                    .from("users")
                    .select("requests")
                    .eq("id", userId)
                    .single();

                if (error || !user) {
                    return callback({ success: false, message: "User not found." });
                }

                // Fetch full user details for each request
                const { data: requestUsers, error: requestError } = await supabase
                    .from("users")
                    .select("id, username, profileImage, level, rank")
                    .in("id", user.requests);

                if (requestError) {
                    return callback({ success: false, message: "Failed to fetch request details." });
                }

                callback({ success: true, requests: requestUsers || [] });
            } catch (error) {
                console.error("Error retrieving connection requests:", error.message);
                callback({ success: false, message: "Failed to retrieve requests." });
            }
        });

        // 📌 Retrieve user connections
        socket.on("getConnections", async ({ userId }, callback) => {
            try {
                // Fetch user from Supabase
                const { data: user, error } = await supabase
                    .from("users")
                    .select("connections")
                    .eq("id", userId)
                    .single();

                if (error || !user) {
                    return callback({ success: false, message: "User not found." });
                }

                // Fetch full details of connections
                const { data: connections, error: connError } = await supabase
                    .from("users")
                    .select("id, username, profileImage, level, rank")
                    .in("id", user.connections);

                if (connError) {
                    return callback({ success: false, message: "Failed to retrieve connections." });
                }

                callback({ success: true, connections: connections || [] });
            } catch (error) {
                console.error("Error retrieving connections:", error.message);
                callback({ success: false, message: "Failed to retrieve connections." });
            }
        });

        // 📌 Accept a connection request
        socket.on("acceptConnection", async ({ userId, targetUserId }, callback) => {
            try {
                // Fetch both users from Supabase
                const { data: user, error: userError } = await supabase
                    .from("users")
                    .select("id, connections, requests")
                    .eq("id", userId)
                    .single();

                const { data: targetUser, error: targetError } = await supabase
                    .from("users")
                    .select("id, connections, requests")
                    .eq("id", targetUserId)
                    .single();

                if (userError || targetError || !user || !targetUser) {
                    return callback({ success: false, message: "User not found." });
                }

                // Remove request from requests list
                const updatedRequests = user.requests.filter(id => id !== targetUserId);
                const updatedUserConnections = [...user.connections, targetUserId];
                const updatedTargetConnections = [...targetUser.connections, userId];

                // Update both users in Supabase
                await supabase
                    .from("users")
                    .update({ requests: updatedRequests, connections: updatedUserConnections })
                    .eq("id", userId);

                await supabase
                    .from("users")
                    .update({ connections: updatedTargetConnections })
                    .eq("id", targetUserId);

                // Notify both users about updated connections
                io.to(userId).emit("updateUsers", updatedUserConnections);
                io.to(targetUserId).emit("updateUsers", updatedTargetConnections);

                callback({ success: true });
            } catch (error) {
                console.error("Error accepting connection:", error.message);
                callback({ success: false, message: "Failed to accept request." });
            }
        });

        // 📌 Ignore a connection request
        socket.on("ignoreConnection", async ({ userId, targetUserId }, callback) => {
            try {
                // Fetch user from Supabase
                const { data: user, error } = await supabase
                    .from("users")
                    .select("requests")
                    .eq("id", userId)
                    .single();

                if (error || !user) {
                    return callback({ success: false, message: "User not found." });
                }

                // Remove request from requests list
                const updatedRequests = user.requests.filter(id => id !== targetUserId);

                // Update Supabase
                await supabase
                    .from("users")
                    .update({ requests: updatedRequests })
                    .eq("id", userId);

                // Notify the user about updated requests list
                io.to(userId).emit("updateConnectionRequests", updatedRequests);

                callback({ success: true });
            } catch (error) {
                console.error("Error ignoring connection request:", error.message);
                callback({ success: false, message: "Failed to ignore request." });
            }
        });

        // 📌 Remove a connection (for both users)
        socket.on("removeConnection", async ({ userId, targetUserId }, callback) => {
            try {
                // Fetch both users from Supabase
                const { data: user, error: userError } = await supabase
                    .from("users")
                    .select("id, connections")
                    .eq("id", userId)
                    .single();

                const { data: targetUser, error: targetError } = await supabase
                    .from("users")
                    .select("id, connections")
                    .eq("id", targetUserId)
                    .single();

                if (userError || targetError || !user || !targetUser) {
                    return callback({ success: false, message: "User not found." });
                }

                // Remove each other from connections
                const updatedUserConnections = user.connections.filter(id => id !== targetUserId);
                const updatedTargetConnections = targetUser.connections.filter(id => id !== userId);

                // Update both users in Supabase
                await supabase
                    .from("users")
                    .update({ connections: updatedUserConnections })
                    .eq("id", userId);

                await supabase
                    .from("users")
                    .update({ connections: updatedTargetConnections })
                    .eq("id", targetUserId);

                // Notify both users about updated connections
                io.to(userId).emit("updateUsers", updatedUserConnections);
                io.to(targetUserId).emit("updateUsers", updatedTargetConnections);

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
