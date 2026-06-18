// Interactive Ink TUI — the unified control panel for visually-3d.
//
//   visually-3d  (in a terminal)  → this TUI
//
// One coherent flow over the create / improve / reproduce modules (which stay
// separate behind the scenes for debugging): pick or create a subject, then
// watch the loop run with its reasoning streaming live. "Continue existing"
// improves/reproduces a saved scene; "Create new" starts from a name/URL.
//
// Written in plain JS with htm (JSX-like, no build step) so it runs directly on
// Node like the rest of lib/.

import process from 'node:process';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import React, { useState, useEffect, useRef } from 'react';
import { render, Box, Text, useApp, useInput } from 'ink';
import SelectInput from 'ink-select-input';
import TextInput from 'ink-text-input';
import htm from 'htm';
import { SCENES_DIR, ensureWorkspace } from '../paths.js';

const html = htm.bind(React.createElement);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(__dirname, '..', '..', 'bin', 'visually.js');

// eslint-disable-next-line no-control-regex
const stripAnsi = (s) => s.replace(/\u001b\[[0-9;]*m/g, '');

function listScenes() {
  try {
    return readdirSync(SCENES_DIR)
      .filter((f) => f.endsWith('.json') && f !== 'index.json')
      .map((f) => f.replace(/\.json$/, ''))
      .sort();
  } catch {
    return [];
  }
}

// ── runner: spawn a subcommand and stream its output into a log pane ─────────
function Runner({ args, onBack }) {
  const [lines, setLines] = useState(['starting…']);
  const [running, setRunning] = useState(true);
  const [code, setCode] = useState(null);
  const procRef = useRef(null);
  const bufRef = useRef('');

  useEffect(() => {
    const proc = spawn(process.execPath, [BIN, ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    procRef.current = proc;
    const onData = (buf) => {
      bufRef.current = (bufRef.current + stripAnsi(buf.toString())).slice(-65536);
      setLines(bufRef.current.split('\n').slice(-400));
    };
    proc.stdout.on('data', onData);
    proc.stderr.on('data', onData);
    proc.on('error', (e) => { onData(Buffer.from(`\nspawn error: ${e.message}\n`)); setRunning(false); setCode(1); });
    proc.on('close', (c) => { setRunning(false); setCode(c); });
    return () => { try { proc.kill('SIGTERM'); } catch { /* gone */ } };
  }, []);

  useInput((input) => {
    if (running && (input === 'x')) { try { procRef.current?.kill('SIGTERM'); } catch { /* gone */ } }
    if (!running && (input === 'b')) onBack();
  });

  const visible = lines.slice(-18);
  const status = running ? '● running' : (code === 0 ? '✓ done' : `✗ exited (${code})`);
  return html`
    <${Box} flexDirection="column">
      <${Box}>
        <${Text} color=${running ? 'yellow' : (code === 0 ? 'green' : 'red')} bold>${status}</${Text}>
        <${Text} dimColor>   visually ${args.join(' ')}</${Text}>
      </${Box}>
      <${Box} flexDirection="column" borderStyle="round" paddingX=${1} marginTop=${1}>
        ${visible.map((l, i) => html`<${Text} key=${i}>${l.length ? l : ' '}</${Text}>`)}
      </${Box}>
      <${Box} marginTop=${1}>
        <${Text} dimColor>${running ? 'x = stop' : 'b = back to menu · q = quit'}   ·   web view: run "visually serve" in another terminal</${Text}>
      </${Box}>
    </${Box}>`;
}

// ── screens ──────────────────────────────────────────────────────────────────
function Menu({ onPick }) {
  const items = [
    { label: '✦  Create new scene', value: 'create' },
    { label: '↻  Continue existing  (improve / reproduce)', value: 'scenes' },
    { label: '✕  Quit', value: 'quit' },
  ];
  return html`
    <${Box} flexDirection="column">
      <${Text} dimColor>What do you want to do?</${Text}>
      <${Box} marginTop=${1}><${SelectInput} items=${items} onSelect=${(it) => onPick(it.value)} /></${Box}>
    </${Box}>`;
}

function CreateForm({ onStart, onBack }) {
  const [name, setName] = useState('');
  const [url, setUrl] = useState('');
  const [field, setField] = useState(0);
  useInput((input, key) => { if (key.escape) onBack(); });
  if (field === 0) {
    return html`
      <${Box} flexDirection="column">
        <${Text}>Subject (e.g. "Prusa i3 MK3S 3D printer", "DeepSeek MoE"):</${Text}>
        <${Box}><${Text} color="cyan">❯ </${Text}><${TextInput} value=${name} onChange=${setName} onSubmit=${() => name.trim() && setField(1)} /></${Box}>
        <${Text} dimColor>Enter to continue · Esc to cancel</${Text}>
      </${Box}>`;
  }
  return html`
    <${Box} flexDirection="column">
      <${Text}>Reference URL (optional — paper / product page):</${Text}>
      <${Box}><${Text} color="cyan">❯ </${Text}><${TextInput} value=${url} onChange=${setUrl} onSubmit=${() => onStart(name.trim(), url.trim())} /></${Box}>
      <${Text} dimColor>Enter to start (mode auto-detected) · Esc to cancel</${Text}>
    </${Box}>`;
}

function SceneList({ onPick, onBack }) {
  const scenes = listScenes();
  useInput((input, key) => { if (key.escape) onBack(); });
  if (!scenes.length) {
    return html`
      <${Box} flexDirection="column">
        <${Text}>No saved scenes in ~/.visually-3d/scenes yet.</${Text}>
        <${Text} dimColor>Esc to go back — create one first.</${Text}>
      </${Box}>`;
  }
  const items = scenes.map((s) => ({ label: s, value: s }));
  return html`
    <${Box} flexDirection="column">
      <${Text}>Pick a scene:</${Text}>
      <${SelectInput} items=${items} onSelect=${(it) => onPick(it.value)} />
      <${Text} dimColor>Esc to go back</${Text}>
    </${Box}>`;
}

function SceneAction({ id, onRun, onBack }) {
  useInput((input, key) => { if (key.escape) onBack(); });
  const items = [
    { label: 'Improve   — visual self-improvement loop', value: ['improve', id] },
    { label: 'Reproduce — implement + verify from the scene', value: ['reproduce', id] },
    { label: 'Back', value: 'back' },
  ];
  return html`
    <${Box} flexDirection="column">
      <${Text}>Scene: <${Text} color="cyan" bold>${id}</${Text}></${Text}>
      <${Box} marginTop=${1}><${SelectInput} items=${items} onSelect=${(it) => (it.value === 'back' ? onBack() : onRun(it.value))} /></${Box}>
    </${Box}>`;
}

function App() {
  const { exit } = useApp();
  const [screen, setScreen] = useState('menu');
  const [runArgs, setRunArgs] = useState(null);
  const [picked, setPicked] = useState(null);

  useInput((input) => { if (input === 'q' && screen !== 'running') exit(); });

  let body;
  if (screen === 'menu') {
    body = html`<${Menu} onPick=${(v) => (v === 'quit' ? exit() : setScreen(v))} />`;
  } else if (screen === 'create') {
    body = html`<${CreateForm} onBack=${() => setScreen('menu')}
      onStart=${(name, url) => { setRunArgs(['create', name, ...(url ? ['--url', url] : [])]); setScreen('running'); }} />`;
  } else if (screen === 'scenes') {
    body = html`<${SceneList} onBack=${() => setScreen('menu')} onPick=${(id) => { setPicked(id); setScreen('sceneAction'); }} />`;
  } else if (screen === 'sceneAction') {
    body = html`<${SceneAction} id=${picked} onBack=${() => setScreen('scenes')}
      onRun=${(args) => { setRunArgs(args); setScreen('running'); }} />`;
  } else if (screen === 'running') {
    body = html`<${Runner} args=${runArgs} onBack=${() => setScreen('menu')} />`;
  }

  return html`
    <${Box} flexDirection="column" paddingX=${1} paddingY=${1}>
      <${Text} bold>visually-3d <${Text} dimColor>— 3D ⇄ implementation loop</${Text}></${Text}>
      <${Box} marginTop=${1}>${body}</${Box}>
    </${Box}>`;
}

export async function runTui() {
  ensureWorkspace();
  if (!process.stdout.isTTY) {
    throw new Error('the TUI needs an interactive terminal (no TTY detected). Use a subcommand like `visually create …` instead.');
  }
  const instance = render(html`<${App} />`);
  await instance.waitUntilExit();
}

export { App };
