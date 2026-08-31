import { spawn } from 'node:child_process';
import { parseExplanations } from './schema.js';
import { SYSTEM_PROMPT, buildUserPrompt, buildRetryPrompt } from './prompt.js';

/**
 * Claude Code carries its own tools and scaffolding. For a single text call we
 * want none of it: one turn, no tools, machine-readable output.
 */
export const CLI_FLAGS = Object.freeze([
  '--max-turns', '1',
  '--output-format', 'json',
  '--disallowed-tools',
  'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'WebSearch', 'WebFetch', 'Task',
]);

/** Pull the assistant text out of the CLI's JSON envelope. */
export function extractResult(stdout) {
  const start = stdout.indexOf('{');
  if (start === -1) throw new Error(`could not parse claude output: ${stdout.slice(0, 200)}`);

  let envelope;
  try {
    envelope = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error(`could not parse claude output: ${stdout.slice(0, 200)}`);
  }

  if (envelope.is_error) throw new Error(`claude cli reported an error: ${envelope.result ?? ''}`);
  return envelope.result ?? '';
}

/**
 * Strip ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN from an env object. Either
 * one silently redirects the `claude` CLI's billing from the user's
 * subscription to the paid API, with no signal anywhere that it happened -
 * so `runClaude` must never let either reach the spawned process, even if
 * they are set in the shell it runs from.
 */
export function sanitizedEnv(env = process.env) {
  const { ANTHROPIC_API_KEY, ANTHROPIC_AUTH_TOKEN, ...rest } = env;
  return rest;
}

/**
 * Spawn `claude -p`. Credentials resolve exactly as they do for the interactive
 * CLI, so this runs on the user's subscription. stdin is closed - the CLI waits
 * on it otherwise and prints a warning after three seconds.
 */
export function runClaude({ prompt, systemPrompt, model, bin = process.env.CLAUDE_BIN || 'claude', timeoutMs = 180000 }) {
  return new Promise((resolve, reject) => {
    const args = ['-p', prompt, '--system-prompt', systemPrompt, '--model', model, ...CLI_FLAGS];
    const child = spawn(bin, args, { stdio: ['ignore', 'pipe', 'pipe'], env: sanitizedEnv() });

    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });

    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`claude timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`claude exited ${code}: ${stderr.slice(0, 200)}`));
      try {
        resolve(extractResult(stdout));
      } catch (err) {
        reject(err);
      }
    });
  });
}

export class ClaudeCliExplainer {
  constructor({ model = 'claude-opus-5', runImpl = runClaude, maxRetries = 1 } = {}) {
    this.model = model;
    this.runImpl = runImpl;
    this.maxRetries = maxRetries;
  }

  /** One call per game, covering every moment. Never throws. */
  async explain({ game, moments }) {
    if (!moments.length) return [];

    let lastError = 'no attempt made';
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const prompt = attempt === 0
        ? buildUserPrompt({ game, moments })
        : buildRetryPrompt({ game, moments, error: lastError });

      let text = '';
      try {
        text = await this.runImpl({ prompt, systemPrompt: SYSTEM_PROMPT, model: this.model });
      } catch (err) {
        lastError = `claude failed: ${err.message}`;
        continue;
      }

      const parsed = parseExplanations(text);
      if (parsed.ok) return alignToMoments(parsed.data, moments);
      lastError = parsed.error;
    }

    console.warn(`[explainer] giving up after ${this.maxRetries + 1} attempts: ${lastError}`);
    return moments.map(() => null);
  }
}

/** Match explanations back to moments by ply; anything unmatched becomes null. */
function alignToMoments(explanations, moments) {
  const byPly = new Map(explanations.map((e) => [e.ply, e]));
  return moments.map((m) => byPly.get(m.ply) ?? null);
}
