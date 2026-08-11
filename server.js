const express = require('express');
const axios = require('axios');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const deviceMemory = {};

// This tells the server to look for a secure variable provided by the cloud host
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;

app.post('/ping', (req, res) => {
    const { instance_id, chat_id, timeout_limit, shift, status } = req.body;

    if (!instance_id) {
        return res.status(400).send("Missing instance_id");
    }

    console.log(`[${new Date().toLocaleTimeString()}] Heartbeat from: ${instance_id}`);

    deviceMemory[instance_id] = {
        chatId: chat_id,
        // Kept as seconds for this final local test
        timeoutLimit: parseInt(timeout_limit), 
        shift: shift,
        lastSeen: Date.now(),
        alertSent: false 
    };

    res.status(200).send("Heartbeat logged successfully");
});

// --- THE SWEEPER LOOP ---
setInterval(() => {
    const currentTime = Date.now();
    
    for (const [instanceId, data] of Object.entries(deviceMemory)) {
        
        const maxSilenceAllowed = data.timeoutLimit * 60000; 
        const timeSinceLastPing = currentTime - data.lastSeen;

        if (timeSinceLastPing > maxSilenceAllowed && !data.alertSent) {
            
            console.log(`\n🚨 ALARM TRIGGERED FOR: ${instanceId} 🚨`);
            
            // Lock the alert
            deviceMemory[instanceId].alertSent = true;

            // 2. The Telegram API Call
            // Formats a clean message for your phone
            const messageText = `🚨 MEDIA ALARM 🚨\n\nInstance: ${instanceId}\nShift: ${data.shift}\nStatus: OFFLINE / SILENT\nSilence Duration: ${Math.floor(timeSinceLastPing / 1000)}s`;
            
            const telegramUrl = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
            
            // Fires the data to your specific chat ID
            axios.post(telegramUrl, {
                chat_id: data.chatId,
                text: messageText
            }).then(() => {
                console.log(`Alert successfully sent to Telegram chat: ${data.chatId}\n`);
            }).catch((error) => {
                console.error(`Failed to send Telegram alert:`, error.message);
            });
        }
    }
}, 5000); 

app.listen(PORT, () => {
    console.log(`Media Alarm Server is running on port ${PORT}`);
    console.log(`Waiting for heartbeats...`);
});