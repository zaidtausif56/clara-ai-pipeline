// taskTracker.js - Local JSON task tracker (outputs/tasks.json)
// Tracks each account through pipeline stages instead of using Asana

const fs = require('fs');
const path = require('path');
const logger = require('./logger');

const TASKS_FILE = path.resolve(__dirname, '..', 'outputs', 'tasks.json');

function createTask(accountId, stage, details = {}) {
  return {
    task_id: `task-${accountId}-${Date.now()}`,
    account_id: accountId,
    stage,
    status: 'in-progress',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    history: [
      {
        stage,
        timestamp: new Date().toISOString(),
        details,
      },
    ],
  };
}

function loadTasks() {
  try {
    if (fs.existsSync(TASKS_FILE)) {
      const raw = fs.readFileSync(TASKS_FILE, 'utf-8');
      return JSON.parse(raw);
    }
  } catch (err) {
    logger.warn(`Failed to load tasks file: ${err.message}`);
  }
  return [];
}

function saveTasks(tasks) {
  const dir = path.dirname(TASKS_FILE);
  if (!dir || !fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(TASKS_FILE, JSON.stringify(tasks, null, 2), 'utf-8');
}

function findTask(accountId) {
  const tasks = loadTasks();
  return tasks.find((t) => t.account_id === accountId) || null;
}

// Create or update a task for an account
function upsertTask(accountId, stage, details = {}) {
  const tasks = loadTasks();
  let task = tasks.find((t) => t.account_id === accountId);

  if (task) {
    task.stage = stage;
    task.status = stage === 'complete' ? 'complete' : 'in-progress';
    task.updated_at = new Date().toISOString();
    task.history.push({
      stage,
      timestamp: new Date().toISOString(),
      details,
    });
    logger.info(`Task updated: ${accountId} -> ${stage}`);
  } else {
    task = createTask(accountId, stage, details);
    tasks.push(task);
    logger.info(`Task created: ${accountId} -> ${stage}`);
  }

  saveTasks(tasks);
  return task;
}

function completeTask(accountId) {
  return upsertTask(accountId, 'complete', { completed: true });
}

function getAllTasks() {
  return loadTasks();
}

module.exports = {
  upsertTask,
  findTask,
  completeTask,
  getAllTasks,
  TASKS_FILE,
};

// CLI: node scripts/taskTracker.js [list|show <account_id>]
if (require.main === module) {
  const cmd = process.argv[2];

  if (cmd === 'list') {
    const tasks = getAllTasks();
    if (tasks.length === 0) {
      console.log('No tasks found.');
    } else {
      for (const t of tasks) {
        console.log(`[${t.status}] ${t.account_id} — ${t.stage} (updated: ${t.updated_at})`);
      }
    }
  } else if (cmd === 'show') {
    const id = process.argv[3];
    if (!id) {
      console.error('Usage: node scripts/taskTracker.js show <account_id>');
      process.exit(1);
    }
    const task = findTask(id);
    if (task) {
      console.log(JSON.stringify(task, null, 2));
    } else {
      console.log(`No task found for account: ${id}`);
    }
  } else {
    console.log('Usage: node scripts/taskTracker.js [list|show <account_id>]');
  }
}
