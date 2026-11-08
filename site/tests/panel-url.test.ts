import { describe, expect, it } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { PANEL, panelUrl, templateUrl } from '../src/lib/panel-url';
import { ReadyAgents } from '../src/components/ready-agents';
import { TEMPLATES } from '../src/lib/templates';
import { Hero } from '../src/components/hero';

describe('panelUrl', () => {
  it('encodes, trims, caps at 500 characters and falls back to the panel root for blank input', () => {
    expect(panelUrl('  Tell me when XLM falls 5% & more  ')).toBe(`${PANEL}/draft?prompt=Tell+me+when+XLM+falls+5%25+%26+more`);
    const long = 'a'.repeat(600);
    expect(new URL(panelUrl(long)).searchParams.get('prompt')).toHaveLength(500);
    expect(panelUrl('')).toBe(`${PANEL}/`);
    expect(panelUrl(' \n\t ')).toBe(`${PANEL}/`);
  });

  it('never includes the site origin or anything but the prompt', () => {
    const u = new URL(panelUrl('x'));
    expect(u.origin).toBe('https://app.agentenact.io');
    expect([...u.searchParams.keys()]).toEqual(['prompt']);
    expect(panelUrl('x')).not.toContain('agentenact.io/#');
  });
});

describe('Hero', () => {
  const html = renderToStaticMarkup(createElement(Hero, { recordHash: 'ab'.repeat(32) }));
  const text = html.replace(/<[^>]+>/g, ' ');
  it('keeps the #create anchor, one prompt box and one submit', () => {
    expect(html).toContain('id="create"');
    expect(html.match(/<input/g)).toHaveLength(1);
    expect(html).toContain('maxLength="500"');
    expect(html.match(/type="submit"/g)).toHaveLength(1);
    expect(text).toContain('Stellar testnet. You see the draft before signing up.');
  });
  it('asks for no wallet on the main path', () => {
    expect(text).not.toMatch(/Freighter|secret|wallet/i);
  });
});

describe('ReadyAgents', () => {
  const html = renderToStaticMarkup(createElement(ReadyAgents));
  const text = html.replace(/<[^>]+>/g, ' ');
  it('links four ready agents to their plans in the panel, and the rest of them on /create', () => {
    const shown = TEMPLATES.filter((t) => html.includes(`href="${templateUrl(t.id)}"`));
    expect(shown).toHaveLength(4);
    for (const t of shown) expect(text).toContain(t.title);
    expect(templateUrl('xlm-drop')).toBe(`${PANEL}/draft?template=xlm-drop`);
    expect(html).toContain('href="/create"');
  });
  it('offers a PIN or password and keeps Face ID optional', () => {
    expect(text).toContain('a PIN or password works, Face ID is optional');
    expect(text).not.toMatch(/email and Face ID/);
  });
});
