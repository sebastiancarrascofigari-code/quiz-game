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
  timeLeft: 0,
  teams: {},
  answers: {},
  scores: {},
  readyTeams: {},
};

function initTeams() {
  gameData.teams.forEach(t => {
    gameState.teams[t.id] = { ...t, connected: false };
    gameState.scores[t.id] = 0;
  });
}
initTeams();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/', (req, res) => res.redirect('/team/1'));
app.get('/host', (req, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));
app.get('/team/:id', (req, res) => res.sendFile(path.join(__dirname, 'public', 'team.html')));

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
    console.log('Host connected');
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
      connectedTeams: getConnectedTeams(),
      readyTeams: Object.keys(gameState.readyTeams).map(Number),
    });
    console.log(`Team ${teamId} (${team.name}) connected`);
  });

  socket.on('team:ready', ({ teamId }) => {
    teamId = parseInt(teamId);
    gameState.readyTeams[teamId] = true;
    const readyCount = Object.keys(gameState.readyTeams).length;
    const totalTeams = gameData.teams.length;
    io.to('host').emit('host:team-ready', {
      teamId, readyCount, totalTeams,
      allReady: readyCount >= totalTeams,
      readyTeams: Object.keys(gameState.readyTeams).map(Number),
    });
    console.log(`Team ${teamId} ready (${readyCount}/${totalTeams})`);
  });

  socket.on('host:start', () => {
    if (gameState.status !== 'waiting') return;
    gameState.status = 'active';
    gameState.currentRound = 0;
    gameState.currentQuestion = 0;
    Object.keys(gameState.scores).forEach(id => gameState.scores[id] = 0);
    io.emit('game:start', {
      title: gameData.title,
      rounds: gameData.rounds.map(r => ({ name: r.name, emoji: r.emoji })),
    });
    setTimeout(() => sendQuestion(), 1500);
  });

  socket.on('host:next', () => {
    if (gameState.status !== 'reveal') return;
    clearTimeout(gameState.autoAdvanceTimer);
    advanceGame();
  });

  socket.on('team:answer', ({ teamId, answerIndex, timeLeft }) => {
    teamId = parseInt(teamId);
    if (gameState.status !== 'question') return;
    if (gameState.answers[teamId] !== undefined) return;
    gameState.answers[teamId] = { answerIndex, timeLeft };
    io.to('host').emit('host:answer-received', {
      teamId,
      answeredCount: Object.keys(gameState.answers).length,
      totalTeams: gameData.teams.length,
    });
    if (Object.keys(gameState.answers).length >= gameData.teams.length) {
      clearTimeout(gameState.timer);
      revealAnswer();
    }
  });

  socket.on('host:reset', () => {
    resetGame();
    io.emit('game:reset');
    io.to('host').emit('host:state', buildHostState());
    console.log('Game reset');
  });

  socket.on('disconnect', () => {
    if (socket.teamId) {
      gameState.teams[socket.teamId].connected = false;
      io.to('host').emit('host:team-disconnected', {
        teamId: socket.teamId,
        connectedTeams: getConnectedTeams(),
      });
    }
  });
});

function sendQuestion() {
  const round = gameData.rounds[gameState.currentRound];
  const question = round.questions[gameState.currentQuestion];
  const timeLimit = question.timeLimit || round.timePerQuestion || 8;
  const totalQ = getTotalQuestionIndex();
  const totalAll = gameData.rounds.reduce((s, r) => s + r.questions.length, 0);

  gameState.status = 'question';
  gameState.answers = {};
  gameState.timeLeft = timeLimit;

  const payload = {
    roundIndex: gameState.currentRound,
    roundName: round.name,
    roundEmoji: round.emoji,
    questionIndex: gameState.currentQuestion,
    totalInRound: round.questions.length,
    globalIndex: totalQ,
    totalQuestions: totalAll,
    type: question.type || 'multiple',
    text: question.text,
    options: question.options,
    timeLimit,
  };

  io.emit('question:show', payload);
  io.to('host').emit('host:question', payload);
  gameState.timer = setTimeout(() => revealAnswer(), timeLimit * 1000);
}

function revealAnswer() {
  if (gameState.status !== 'question') return;
  gameState.status = 'reveal';

  const round = gameData.rounds[gameState.currentRound];
  const question = round.questions[gameState.currentQuestion];

  const questionScores = {};
  gameData.teams.forEach(t => {
    const answer = gameState.answers[t.id];
    let points = (answer !== undefined && answer.answerIndex === question.correct) ? 1 : 0;
    questionScores[t.id] = points;
    gameState.scores[t.id] = (gameState.scores[t.id] || 0) + points;
  });

  const revealPayload = {
    correctIndex: question.correct,
    answers: gameState.answers,
    questionScores,
    totalScores: { ...gameState.scores },
    teams: gameData.teams,
  };

  io.emit('question:reveal', { ...revealPayload, autoAdvanceIn: 2 });
  io.to('host').emit('host:reveal', { ...revealPayload, autoAdvanceIn: 2 });
  gameState.autoAdvanceTimer = setTimeout(() => advanceGame(), 2000);
}

function advanceGame() {
  const round = gameData.rounds[gameState.currentRound];
  gameState.currentQuestion++;

  if (gameState.currentQuestion >= round.questions.length) {
    gameState.currentRound++;
    gameState.currentQuestion = 0;
    if (gameState.currentRound >= gameData.rounds.length) {
      endGame();
      return;
    }
    io.emit('round:start', {
      roundIndex: gameState.currentRound,
      roundName: gameData.rounds[gameState.currentRound].name,
      roundEmoji: gameData.rounds[gameState.currentRound].emoji,
      scores: gameState.scores,
    });
    setTimeout(() => sendQuestion(), 3000);
  } else {
    sendQuestion();
  }
}

function endGame() {
  gameState.status = 'finished';
  const rankings = gameData.teams
    .map(t => ({ ...t, score: gameState.scores[t.id] || 0 }))
    .sort((a, b) => b.score - a.score);
  io.emit('game:end', { rankings, scores: gameState.scores });
  io.to('host').emit('host:end', { rankings, scores: gameState.scores });
}

function resetGame() {
  clearTimeout(gameState.timer);
  clearTimeout(gameState.autoAdvanceTimer);
  gameState.status = 'waiting';
  gameState.currentRound = 0;
  gameState.currentQuestion = 0;
  gameState.answers = {};
  gameState.readyTeams = {};
  Object.keys(gameState.scores).forEach(id => gameState.scores[id] = 0);
  Object.keys(gameState.teams).forEach(id => { gameState.teams[id].connected = false; });
}

function getTotalQuestionIndex() {
  let total = 0;
  for (let i = 0; i < gameState.currentRound; i++) total += gameData.rounds[i].questions.length;
  return total + gameState.currentQuestion + 1;
}

function getConnectedTeams() {
  return gameData.teams
    .filter(t => gameState.teams[t.id]?.connected)
    .map(t => ({ id: t.id, name: t.name, emoji: t.emoji }));
}

function buildHostState() {
  return {
    status: gameState.status,
    config: {
      title: gameData.title,
      rounds: gameData.rounds.map(r => ({ name: r.name, emoji: r.emoji, count: r.questions.length })),
    },
    connectedTeams: getConnectedTeams(),
    readyTeams: Object.keys(gameState.readyTeams).map(Number),
    scores: gameState.scores,
  };
}

function buildTeamState(teamId) {
  return {
    status: gameState.status,
    teamId,
    team: gameData.teams.find(t => t.id === parseInt(teamId)),
    scores: gameState.scores,
    config: { title: gameData.title, subtitle: gameData.subtitle },
  };
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`🎮 Quiz Game corriendo en http://localhost:${PORT}`);
});
