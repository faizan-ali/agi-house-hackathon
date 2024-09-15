require('dotenv').config();

import axios from "axios";

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Microphone = require('node-microphone');
const fs = require('fs');
const path = require('path');
import qs from 'qs';

let isFlashing = false

const changeLights = async (color: 'Cool white' | 'Ocean' | 'Candlelight'): Promise<void> => {
    await fetch("http://homeassistant.local:8123/api/services/light/turn_on", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": "Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJiOWRiYjhiYzlmZjU0ZjE4YjU2MGI1YzVhMmQxZTY3YiIsImlhdCI6MTcyNjM1NzYyNCwiZXhwIjoyMDQxNzE3NjI0fQ.FZBnmipg67NzY2G8CfR-HbRr9l_Sx8U-EIa-1PAsEHc"
        },
        body: JSON.stringify({
            entity_id: "light.wiz_rgbw_tunable_4b588c",
            effect: color
        })
    })
}

const wait = (ms: number) => {
    return new Promise(resolve => setTimeout(resolve, ms));
}

interface SentimentAnalysisResponse {
    topics: Array<{
        id: string
        text: string
        type: string
        score: number
        messageIds: Array<string>
        sentiment: {
            polarity: {
                score: number
            }
            suggested: string
        }
        parentRefs: Array<any>
    }>
}

const app = express();
const server = http.createServer(app);
const io = socketIo(server);

// Symbl.ai credentials
const APP_ID = process.env.SYMBL_APP_ID;
const APP_SECRET = process.env.SYMBL_APP_SECRET;

let microphone = null;

// Audio settings
const SAMPLE_RATE = 16000;
const RECORD_DURATION = 8000; // Record for 30 seconds

// Create directories for saving files
const audioDir = path.join(__dirname, 'saved_audio');
const transcriptionDir = path.join(__dirname, 'transcriptions');
fs.mkdirSync(audioDir, {recursive: true});
fs.mkdirSync(transcriptionDir, {recursive: true});

let accessToken = ''

// Getting auth token
fetch('https://api.symbl.ai/oauth2/token:generate', {
    method: 'post',
    headers: {
        'Content-Type': "application/json",
    },
    body: JSON.stringify({
        type: 'application',
        appId: APP_ID,
        appSecret: APP_SECRET
    })
}).then(_ => _.json()).then(token => {
    accessToken = token.accessToken
})

async function startRecording() {
    console.log('Starting recording...');

    const audioFilePath = path.join(audioDir, `audio_${Date.now()}.wav`);
    const audioStream = fs.createWriteStream(audioFilePath);

    microphone = new Microphone({
        rate: SAMPLE_RATE.toString(),
        channels: '1',
        encoding: 'signed-integer',
        bitwidth: '16'
    });

    const micStream = microphone.startRecording();

    micStream.on('data', (data) => {
        audioStream.write(data);
    });

    micStream.on('error', (error) => {
        console.error('Error from microphone:', error);
    });

    // Stop recording after RECORD_DURATION
    setTimeout(() => {
        microphone.stopRecording();
        audioStream.end();
        console.log('Recording stopped');
        processAudio(audioFilePath);
    }, RECORD_DURATION);
}

async function processAudio(audioFilePath) {
    try {
        console.log('Processing audio...');

        const formData = new FormData();
        formData.append('name', 'Audio Processing Job');
        formData.append('file', fs.createReadStream(audioFilePath));

        const symblaiParams = {
            'name': 'Submit Audio File Example - Node.js'
        }
        console.log('Processing audio')
        const response = await fetch(`https://api.symbl.ai/v1/process/audio`, {
            method: 'post',
            body: fs.createReadStream(audioFilePath),
            // @ts-expect-error asdf
            duplex: 'half',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'audio/wave',
            }
        }).then(_ => _.json()).catch(e => {
            console.error('Error processing audio:', e);
            throw e
        });

        console.log('Processed audio', response)

        const conversationId = response.conversationId;
        const jobId = response.jobId;

        console.log('Audio processing job submitted');

        // Wait for the job to complete
        await waitForJobCompletion(jobId, accessToken);

        // Get messages (transcription)
        const messages = await getMessages(conversationId, accessToken);
        const transcriptionFilePath = path.join(transcriptionDir, `transcription_${Date.now()}.txt`);
        fs.writeFileSync(transcriptionFilePath, JSON.stringify(messages, null, 2));
        console.log('Transcription saved');
        io.emit('transcription', messages);

        // Get sentiment analysis
        const sentimentAnalysis: SentimentAnalysisResponse = await getConversationData(conversationId, accessToken);
        const isNegative = sentimentAnalysis.topics.some(topic => topic.sentiment.polarity.score <= 0)

        if (isNegative && !isFlashing) {
            isFlashing = true
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Ocean')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Ocean')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Ocean')
            await wait(500)
            await changeLights('Candlelight')
            isFlashing = false
        }

    } catch (error) {
        console.error('Error processing audio:', error);
        if (error.response) {
            console.error('Response data:', error.response.data);
            console.error('Response status:', error.response.status);
            console.error('Response headers:', error.response.headers);
        }
    }
}

async function waitForJobCompletion(jobId, authToken) {
    while (true) {
        console.log('Waiting for job completion')
        const response = await axios.get(`https://api.symbl.ai/v1/job/${jobId}`, {
            headers: {'Authorization': `Bearer ${authToken}`}
        });
        if (response.data.status === 'completed') {
            console.log('Job completed');
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
    }
}

async function getMessages(conversationId, authToken) {
    console.log('Getting messages')
    const response = await axios.get(`https://api.symbl.ai/v1/conversations/${conversationId}/messages`, {
        headers: {'Authorization': `Bearer ${authToken}`}
    });
    return response.data.messages;
}

async function getConversationData(conversationId, authToken) {
    const query = {sentiment: true}
    console.log(`Getting conversation data for conversation ID: ${conversationId}`);
    const response = await axios.get(`https://api.symbl.ai/v1/conversations/${conversationId}/topics?${qs.stringify(query)}`, {
        headers: {'Authorization': `Bearer ${authToken}`}
    });
    return response.data;
}

io.on('connection', (socket) => {
    console.log('Client connected');

    socket.on('disconnect', () => {
        console.log('Client disconnected');
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, async () => {
    console.log(`Server running on port ${PORT}`);
    await startRecording();
});

// Graceful shutdown
process.on('SIGINT', () => {
    console.log('Shutting down server...');
    if (microphone) {
        microphone.stopRecording();
    }
    server.close(() => {
        console.log('Server shut down');
        process.exit(0);
    });
});