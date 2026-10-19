import { readFile } from 'node:fs/promises';
import type { Provider } from './codex.js';
import { shellQuote } from './tmux.js';

export type Presentation = { color: boolean; version: string };

export function useColor(env: NodeJS.ProcessEnv = process.env): boolean {
  return !env.NO_COLOR && env.TERM !== 'dumb';
}

export async function loadPresentation(env: NodeJS.ProcessEnv = process.env): Promise<Presentation> {
  const { version } = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
  return { color: useColor(env), version };
}

const logo = String.raw`         __                __    __
   _____/ /_  ____  __  __/ /___/ /__  _____
  / ___/ __ \/ __ \/ / / / / __  / _ \/ ___/
 (__  ) / / / /_/ / /_/ / / /_/ /  __/ /
/____/_/ /_/\____/\__,_/_/\__,_/\___/_/`.split('\n');

const headerCondition = '#{&&:#{@shoulder_banner},#{&&:#{e|>=:#{client_width},120},#{e|>=:#{client_height},32}}}';
const headerLayout = `set-option -gF @shoulder_header_full '${headerCondition}' ; set-option -gF status '#{?@shoulder_header_full,5,on}' ; set-option -gF status-position '#{?@shoulder_banner,top,bottom}' ; set-window-option -gF pane-border-status '#{?@shoulder_header_full,top,bottom}'`;
const bannerButton = '#[range=user|banner-toggle][#{?@shoulder_banner,Hide banner,Show banner}]#[norange]';

// Static tmux commands only: no shell, preference file, or native input.
export function bannerToggleCommand(): string {
  return `set-option -gF @shoulder_banner '#{?@shoulder_banner,0,1}' ; ${headerLayout}`;
}

function actionLabels(color: boolean, reopen: boolean): { text: string; formatted: string } {
  const label = reopen ? 'Reopen side' : '#{?@side_exists,Close side,Open side}';
  return {
    text: `drag + e  [Clear side] [${label}]`,
    formatted: `#[dim]drag + e  #[default]#[range=user|side-clear][Clear side]#[norange] ${color ? '#[fg=cyan]' : '#[bold]'}#[range=user|side-close][${label}]#[norange]#[default]`,
  };
}

// These are tmux status formats, not terminal input or a second live pane.
// Keep every row at the same display width so the slanted letters align.
export function startupHeader(presentation: Presentation, provider: Provider, directKeys = provider === 'codex'): string[] {
  const accent = (text: string) => `${presentation.color ? '#[fg=cyan]' : ''}#[bold]${text}#[default]`;
  const muted = (text: string) => `#[dim]${text}#[default]`;
  const native = provider === 'codex' ? 'Codex' : provider === 'claude' ? 'Claude Code (main only)' : 'Native CLI (main only)';
  const right = [
    muted(`v${presentation.version} · ${native}`.padEnd(48)),
    'Room for a side question.'.padEnd(48),
    muted((directKeys ? 'Ctrl+\\  switch panes · Ctrl+Q  open/close' : 'Ctrl-b o  switch panes').padEnd(48)),
    muted((directKeys ? 'Ctrl-b c clear · b banner' : 'Ctrl-b c clear · x open/close · b banner').padEnd(48)),
    `#{?@side_hidden,${[true, false].map(reopen => {
      const action = actionLabels(presentation.color, reopen);
      return action.formatted + ' '.repeat(48 - action.text.replace('#{?@side_exists,Close side,Open side}', 'Close side').length);
    }).join(',')}}`,
  ];
  const leftWidth = Math.max(...logo.map(row => row.length));
  return logo.map((row, index) => `#[align=left]${accent(row.padEnd(leftWidth))}      ${right[index]}${index === 4 ? ` ${bannerButton}` : ''}`);
}

export function presentationCommands(presentation: Presentation, banner: boolean, columns: number, rows: number, provider: Provider, directKeys = provider === 'codex'): string[][] {
  const accent = presentation.color ? '#[fg=cyan]#[bold]' : '#[bold]';
  const brand = `${accent}▰ shoulder#[default]`;
  const identity = `#{?#{e|>=:#{client_width},65},${brand},${accent}▰#[default]}`;
  const hint = '#{?#{e|>=:#{client_width},90},#[dim]drag + e  #[default],}';
  const clear = '#[range=user|side-clear][Clear side]#[norange]';
  const toggle = `${presentation.color ? '#[fg=cyan]' : '#[bold]'}#[range=user|side-close][#{?@side_hidden,Reopen side,#{?@side_exists,Close side,Open side}}]#[norange]#[default]`;
  const controls = ` ${identity}  ${hint}${clear} ${toggle} #{?#{e|>=:#{client_width},80},${bannerButton} ,}`;
  const context = '#{?#{e|>=:#{client_width},115},#[align=right]#[dim]#{status-right} #[default],}';
  const footer = `${controls}${context}`;
  const expanded = banner && columns >= 120 && rows >= 32;
  const commands = [
    ['set-option', '-g', 'status-style', 'fg=default,bg=default'],
    ['set-option', '-g', 'message-style', 'fg=default,bg=default,bold'],
    ['set-window-option', '-g', 'pane-border-style', 'fg=default,dim'],
    ['set-window-option', '-g', 'pane-active-border-style', presentation.color ? 'fg=cyan' : 'fg=default,bold'],
    ['set-option', '-g', 'status-left-length', '100'],
    ['set-option', '-g', 'status-left', controls],
    ['set-option', '-g', '@shoulder_banner', banner ? '1' : '0'],
    ['set-option', '-g', 'status-position', banner ? 'top' : 'bottom'],
    ['set-window-option', '-g', 'pane-border-status', expanded ? 'top' : 'bottom'],
    ['set-window-option', '-g', 'pane-border-format', '#{?@shoulder_header_full, #{pane_title} #{R: ,#{pane_width}}, #{pane_title} }'],
    ['set-option', '-g', 'status', expanded ? '5' : 'on'],
    ['set-option', '-g', 'status-format[0]', footer],
  ];
  {
    const header = startupHeader(presentation, provider, directKeys);
    commands.push(['set-option', '-g', '@shoulder_header_full', expanded ? '1' : '0']);
    commands.push(['set-option', '-g', 'status-format[0]', `#{?@shoulder_header_full,${header[0]},${footer}}`]);
    const wideContext = '#{?#{e|>=:#{client_width},165},#[align=right]#[dim]#{status-right} #[default],}';
    for (let i = 1; i < header.length; i++) commands.push(['set-option', '-g', `status-format[${i}]`, header[i]! + (i === 4 ? wideContext : '')]);
    // Event-only layout changes run entirely inside tmux: no polling, sleep,
    // subprocess, input interception, or additional terminal process.
    const hook = `if-shell -F 1 ${shellQuote(headerLayout)}`;
    for (const event of ['client-attached', 'client-resized']) commands.push(['set-hook', '-g', event, hook]);
  }
  return commands;
}
