const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Load questions
let gameData = JSON.parse(fs.readFileSync('./questions.json', 'utf-8'));

// Game state
let gameState = {
  status: 'waiting',
  currentRound: 0,
  currentQuestion: 0,
  timer: null,
  autoAdvanceTimer: null,
  timeLeft: 0,
  teams: {},
  answers: {},
  scores: {},
};

function initTeams() {
  gameData.teams.forEach(t => {
    gameState.teams[t.id] = { ...t, connected: false };
    gameState.scores[t.id] = 0;
  });
}
initTeams();

app.use(express.static(__dirname));
app.get('/', (req, res) => res.redirect('/team/1'));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'host.html')));
app.get('/team/:id', (req, res) => res.sendFile(path.join(__dirname, 'team.html')));

app.get('/api/config', (req, res) => {
  res.json({
    title: gameData.title,
    subtitle: gameData.subtitle,
    teams: gameData.teams,
    totalRounds: gameData.rounds.length,
    totalQuestions: gameData.rounds.reduce((sum, r) => sum + r.questions.length, 0),
    rounds: gameData.rounds.map(r => ({ name: r.name, emoji: r.emoji, count: r.questions.length })),
  });
});

io.on('connection', (socket) => {

  socket.on('host:join', () => {
    socket.join('host');
    socket.emit('host:state', buildHostState());
  });

  socket.on('team:join', ({ teamId }) => {
    const team = gameData.teams.find(t => t.id === parseInt(teamId));
    if (!team) return;
    socket.teamId = parseInt(teamId);
    socket.join(`team_${teamId}`);
    gameState.teams[teamId].connected = true;
    gameState.teams[teamId].socketId = socket.id;
    socket.emit('team:state', buildTeamState(teamId));
    io.to('host').emit('host:team-connected', {
      teamId, name: team.name, emoji: team.emoji,
      connectedTeams
