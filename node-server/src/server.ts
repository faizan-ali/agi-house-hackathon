import {Readable} from "node:stream";

require('dotenv').config();

import axios from "axios";

const express = require('express');
const http = require('http');
const socketIo = require('socket.io');
const Microphone = require('node-microphone');
const fs = require('fs');
const path = require('path');
import qs from 'qs';

const {exec} = require("child_process");

let isFlashing = false

let hasSaid = false

const SAMPLE_RATE = 16000;

const changeLights = async (color: 'Cool white' | 'Ocean' | 'Romance'): Promise<void> => {
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
const CHUNK_DURATION_IN_SECONDS = 3
const OVERLAP_DURATION_IN_SECONDS = 2

let isRecording = false;
let recordingStream: Readable | null = null;
let audioBuffer: Buffer[] = [];

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

async function startRecordingLoop() {
    console.log('Starting recording loop...');
    isRecording = true;

    microphone = new Microphone({
        rate: '16000',
        channels: '1',
        encoding: 'signed-integer',
        bitwidth: '16'
    });

    recordingStream = microphone.startRecording();

    recordingStream.on('data', (data) => {
        audioBuffer.push(data);
        if (Buffer.concat(audioBuffer).length >= SAMPLE_RATE * 2 * 2) { // 2 seconds of 16-bit audio
            processChunk();
        }
    });

    recordingStream.on('error', (error) => {
        console.error('Error from microphone:', error);
    });
}

function writeWavHeader(header: Buffer, audioLength: number) {
    // Write WAV header
    header.write('RIFF', 0);
    header.writeUInt32LE(36 + audioLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(1, 22);
    header.writeUInt32LE(SAMPLE_RATE, 24);
    header.writeUInt32LE(SAMPLE_RATE * 2, 28);
    header.writeUInt16LE(2, 32);
    header.writeUInt16LE(16, 34);
    header.write('data', 36);
    header.writeUInt32LE(audioLength, 40);
}


async function processChunk() {
    const BYTES_PER_SAMPLE = 2;
    const chunkBuffer = Buffer.concat(audioBuffer);
    const chunkDuration = chunkBuffer.length / (SAMPLE_RATE * 2); // Duration in seconds


    if (chunkDuration >= CHUNK_DURATION_IN_SECONDS) {
        const chunkStartTime = Date.now();
        const audioFilePath = path.join(audioDir, `audio_${chunkStartTime}.wav`);

        // Write WAV header
        const header = Buffer.alloc(44);
        writeWavHeader(header, chunkBuffer.length);

        fs.writeFileSync(audioFilePath, Buffer.concat([header, chunkBuffer]));
        // Process the recorded chunk
        processAudio(audioFilePath);

        const overlapSamples = SAMPLE_RATE * BYTES_PER_SAMPLE * OVERLAP_DURATION_IN_SECONDS;
        audioBuffer = [chunkBuffer.slice(-overlapSamples)];
    }
}

async function processAudio(audioFilePath) {
    try {
        const formData = new FormData();
        formData.append('name', 'Audio Processing Job');
        formData.append('file', fs.createReadStream(audioFilePath));

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


        const conversationId = response.conversationId;
        const jobId = response.jobId;

        // Wait for the job to complete
        await waitForJobCompletion(jobId, accessToken);

        // Get sentiment analysis
        const sentimentAnalysis: SentimentAnalysisResponse = await getConversationData(conversationId, accessToken);
        const isNegative = sentimentAnalysis.topics.some(topic => topic.sentiment.polarity.score <= -0.5)

        console.log(`SENTIMENT: ${isNegative ? 'NEGATIVE' : 'POSITIVE'}`)

        if (isNegative && !isFlashing) {
            void changeLights('Cool white')

            if (!hasSaid) {
                exec('say "Guys calm down, take three deep breaths"')
                hasSaid = true
            }

            isFlashing = true
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Cool white')
            await wait(500)
            await changeLights('Romance')
            await wait(500)
            await changeLights('Cool white')

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
        const response = await axios.get(`https://api.symbl.ai/v1/job/${jobId}`, {
            headers: {'Authorization': `Bearer ${authToken}`}
        });
        if (response.data.status === 'completed') {
            return;
        }
        await new Promise(resolve => setTimeout(resolve, 1000)); // Wait for 1 second before checking again
    }
}

async function getConversationData(conversationId, authToken) {
    const query = {sentiment: true}
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
    await startRecordingLoop();
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