const { normalizeRole } = require('../utils/helpers');


// handle room management for socket.io
class RoomManager {
    
    // join user to their personal room
    joinUserRoom(socket, userId) {
        if (!userId) {
            console.error('joinUserRoom called with invalid userId');
            return null;
        }
        const roomName = `user:${userId}`;
        socket.join(roomName);
        console.log(`User ${userId} joined room: ${roomName}`);
        return roomName;
    }
    
    
    // join staff to role-based room
    joinRoleRoom(socket, role, jobRole) {
        if (role === 'staff' && jobRole) {
            // Normalize job role to match duty staffRole format
            const normalizedRole = normalizeRole(jobRole);
            if (!normalizedRole) {
                console.error(`joinRoleRoom: could not normalize jobRole "${jobRole}"`);
                return null;
            }
            const roomName = `role:staff:${normalizedRole}`;
            socket.join(roomName);
            console.log(`Staff member joined role room: ${roomName}`);
            return roomName;
        }
        return null;
    }
    
    
    // join duty-specific room (optional, for future use)
    joinDutyRoom(socket, dutyId) {
        if (!dutyId) {
            console.error('joinDutyRoom called with invalid dutyId');
            return null;
        }
        const roomName = `duty:${dutyId}`;
        socket.join(roomName);
        console.log(`Socket joined duty room: ${roomName}`);
        return roomName;
    }
    
    
    // leave all rooms on disconnect
    leaveAllRooms(socket) {
        const rooms = Array.from(socket.rooms);
        rooms.forEach(room => {
            // Don't leave the socket's own room (socket.id)
            if (room !== socket.id) {
                socket.leave(room);
                console.log(`Socket ${socket.id} left room: ${room}`);
            }
        });
    }
    
    
    // get all rooms a socket is currently in
    getRooms(socket) {
        return Array.from(socket.rooms).filter(room => room !== socket.id);
    }


    // join tracking room for real-time location sharing
    joinTrackingRoom(socket, staffId, dutyId) {
        if (!staffId || !dutyId) {
            console.error('joinTrackingRoom called with invalid parameters');
            return null;
        }
        const roomName = `tracking:${staffId}:${dutyId}`;
        socket.join(roomName);
        console.log(`Staff ${staffId} joined tracking room: ${roomName}`);
        return roomName;
    }

    
    // join hospital tracking room
    joinHospitalTrackingRoom(socket, hospitalId) {
        if (!hospitalId) {
            console.error('joinHospitalTrackingRoom called with invalid hospitalId');
            return null;
        }
        const roomName = `hospital_tracking:${hospitalId}`;
        socket.join(roomName);
        console.log(`Socket joined hospital tracking room: ${roomName}`);
        return roomName;
    }

    
    // leave tracking room
    leaveTrackingRoom(socket, staffId, dutyId) {
        const roomName = `tracking:${staffId}:${dutyId}`;
        socket.leave(roomName);
        console.log(`Staff ${staffId} left tracking room: ${roomName}`);
    }
}

module.exports = new RoomManager();
