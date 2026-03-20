import {
  AgentTile,
  BucketState,
  FeedPost,
  LandingBriefAgent,
  LandingBriefData,
  SprintState,
} from './types';

type OptionLike = Pick<AgentTile, 'handle' | 'bucket' | 'mission' | 'track' | 'approachGroup' | 'approachLabel' | 'lastPost'>;

export interface OverviewModel {
  phase: string;
  summary: string;
  focus: string;
  recommendation: string;
  optionCount: number;
  needsInputCount: number;
  readyCount: number;
}

export interface OptionCardModel {
  id: string;
  title: string;
  track: string | null;
  status: string;
  tone: BucketState;
  summary: string;
  nextStep: string;
  latestNote: string | null;
  memberSentence: string;
}

export interface DecisionOptionModel {
  id: string;
  title: string;
  status: string;
  tone: 'passed' | 'crashed' | 'running';
  verdict: string;
  whyItMatters: string;
  whatItReuses: string | null;
  existingCodeGap: string | null;
  evidence: string | null;
  concern: string | null;
}

export interface DecisionBriefModel {
  headline: string;
  recommendation: string;
  compressionNote: string | null;
  options: DecisionOptionModel[];
}

export interface TimelineEntryModel {
  id: string;
  label: string;
  actor: string;
  sentence: string;
  time: string;
}

export type BoardColumnId =
  | 'needs_input'
  | 'ready_to_compare'
  | 'exploring'
  | 'survives'
  | 'discarded';

export type BoardTone =
  | BucketState
  | 'passed'
  | 'crashed'
  | 'running';

export interface BoardDrawerLabel {
  icon: string;
  label: string;
}

export interface BoardDrawerSection {
  id: string;
  title: string;
  icon: string;
  body: string;
}

export interface BoardTileModel {
  id: string;
  title: string;
  track: string | null;
  status: string;
  column: BoardColumnId;
  tone: BoardTone;
  cardLine: string;
  summary: string;
  whyAlive: string;
  latestSignal: string;
  nextMove: string;
  risk: string;
  memberSentence: string;
  hypothesis: string | null;
  whatItReuses: string | null;
  existingCodeGap: string | null;
  evidence: string | null;
  drawerLabel: BoardDrawerLabel;
  drawerOverview: string;
  drawerSections: BoardDrawerSection[];
  drawerObservation: string;
}

export interface BoardColumnModel {
  id: BoardColumnId;
  title: string;
  stage: string;
  description: string;
  tiles: BoardTileModel[];
}

export interface BoardStatModel {
  label: string;
  value: string;
  note: string;
}

export interface BoardModel {
  headline: string;
  summary: string;
  columns: BoardColumnModel[];
  stats: BoardStatModel[];
}

const bucketPriority: Record<BucketState, number> = {
  blocked: 0,
  review: 1,
  in_progress: 2,
  planning: 3,
  done: 4,
};

const bucketStatusCopy: Record<BucketState, { label: string; next: string }> = {
  planning: {
    label: 'Framing',
    next: 'The route is still being shaped before more work is added.',
  },
  in_progress: {
    label: 'Exploring',
    next: 'Let this route finish its current pass before expanding it.',
  },
  blocked: {
    label: 'Needs input',
    next: 'A human decision is needed before this route can move forward.',
  },
  review: {
    label: 'Ready to compare',
    next: 'This route is ready to be compared against the other options.',
  },
  done: {
    label: 'Completed',
    next: 'This route has finished its current pass and is waiting to be kept or discarded.',
  },
};

function titleCase(value: string): string {
  return value
    .split(' ')
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(' ');
}

export function humanizeIdentifier(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value
    .replace(/^[@#]/, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return null;
  return titleCase(cleaned);
}

function firstSentence(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const match = trimmed.match(/^(.+?[.!?])(?:\s|$)/);
  return match ? match[1].trim() : trimmed;
}

function clampSentence(value: string | null | undefined, fallback: string): string {
  return firstSentence(value) ?? fallback;
}

function sentenceCase(value: string): string {
  if (!value) return value;
  return value.charAt(0).toUpperCase() + value.slice(1);
}

function lowerCaseFirst(value: string): string {
  if (!value) return value;
  return value.charAt(0).toLowerCase() + value.slice(1);
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[.?!]+$/, '').trim();
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function stripFillerPrefixes(value: string): string {
  return value
    .replace(/^this route\s+/i, '')
    .replace(/^the route\s+/i, '')
    .replace(/^route\s+/i, '')
    .replace(/^this idea\s+/i, '')
    .replace(/^the idea\s+/i, '')
    .replace(/^it\s+/i, '');
}

function stripSoftQualifiers(value: string): string {
  return value
    .replace(/\b(currently|right now|basically|really|simply|just|already)\b/gi, '')
    .replace(/\b(still)\b/gi, '');
}

function cleanSentenceCore(value: string | null | undefined, fallback: string): string {
  const raw = firstSentence(value) ?? fallback;
  const cleaned = normalizeWhitespace(stripSoftQualifiers(stripFillerPrefixes(raw)));
  const repaired = /^(is|was|were|has|had|cannot|can not|can't|won't|will not)\b/i.test(cleaned)
    ? `it ${cleaned}`
    : cleaned;
  return sentenceCase(stripTrailingPunctuation(repaired || fallback));
}

function semanticShorten(value: string, limit = 84): string {
  let result = normalizeWhitespace(value);
  const clauses = ['; ', ', because ', ' because ', ', but ', ' but ', ', while ', ' while ', '. '];

  for (const clause of clauses) {
    if (result.length <= limit || !result.includes(clause)) continue;
    const candidate = result.split(clause)[0]?.trim();
    if (candidate && candidate.length >= 28) {
      result = candidate;
    }
  }

  result = normalizeWhitespace(result.replace(/\([^)]*\)/g, ' '));

  if (result.length <= limit) return result;

  const words = result.split(' ');
  let shortened = '';
  for (const word of words) {
    const next = shortened ? `${shortened} ${word}` : word;
    if (next.length > limit - 1) break;
    shortened = next;
  }

  if (!shortened) {
    return `${result.slice(0, limit - 1).trimEnd()}…`;
  }

  return shortened.length < result.length ? `${shortened}…` : shortened;
}

function finishSentence(value: string, limit = 84): string {
  const shortened = semanticShorten(value, limit);
  if (shortened.endsWith('…')) return shortened;
  return /[.?!]$/.test(shortened) ? shortened : `${shortened}.`;
}

function stripActionLead(value: string): string {
  return value
    .replace(/^(try|trying|test|testing|explore|exploring)\s+/i, '')
    .trim();
}

function stripBecauseLead(value: string): string {
  return value.replace(/^because\s+/i, '').trim();
}

function ensureImplicitSubject(value: string): string {
  return /^(reuses|keeps|adds|solves|handles|uses|extends|reduces|avoids|simplifies|works|proves)\b/i.test(value)
    ? `it ${value}`
    : value;
}

function extractDecisionPrompt(...sources: Array<string | null | undefined>): string | null {
  for (const source of sources) {
    const sentence = firstSentence(source);
    if (!sentence) continue;

    const whetherMatch = sentence.match(/\bwhether\s+(.+)/i);
    if (whetherMatch?.[1]) {
      return finishSentence(`Decide whether ${lowerCaseFirst(stripTrailingPunctuation(whetherMatch[1]))}`, 82);
    }

    const shouldMatch = sentence.match(/\bshould\s+(.+)/i);
    if (shouldMatch?.[1]) {
      const shouldSentence = stripTrailingPunctuation(sentence);
      const naturalShouldMatch = shouldSentence.match(
        /^should\s+(.+?)\s+(be|live|stay|use|reuse|move|ship|keep|add|remove|split|run|happen|exist|change|start|stop|continue)\b(.*)$/i,
      );
      if (naturalShouldMatch) {
        const [, subject, verb, rest] = naturalShouldMatch;
        return finishSentence(`Decide whether ${lowerCaseFirst(subject)} should ${verb}${rest}`, 82);
      }
      return finishSentence(
        `Decide whether ${lowerCaseFirst(shouldSentence.replace(/^should\s+/i, ''))}`,
        82,
      );
    }

    if (sentence.includes('?')) {
      return finishSentence(sentenceCase(stripTrailingPunctuation(sentence)), 82);
    }
  }

  return null;
}

function combineSentences(...values: Array<string | null | undefined>): string {
  const unique: string[] = [];
  const seen = new Set<string>();

  for (const value of values) {
    const sentence = firstSentence(value);
    if (!sentence) continue;
    const normalized = normalizeWhitespace(stripTrailingPunctuation(sentence).toLowerCase());
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    unique.push(sentenceCase(stripTrailingPunctuation(sentence)));
    if (unique.length === 2) break;
  }

  if (unique.length === 0) return '';
  return finishSentence(unique.join('. '), 180);
}

function drawerLabelFor(column: BoardColumnId): BoardDrawerLabel {
  if (column === 'survives') return { icon: 'verified', label: 'Active survivor' };
  if (column === 'ready_to_compare') return { icon: 'balance', label: 'Ready to compare' };
  if (column === 'needs_input') return { icon: 'help', label: 'Decision needed' };
  if (column === 'discarded') return { icon: 'archive', label: 'Archived route' };
  return { icon: 'science', label: 'Active hypothesis' };
}

function makeDrawerSection(
  id: string,
  title: string,
  icon: string,
  body: string | null | undefined,
): BoardDrawerSection | null {
  const sentence = firstSentence(body);
  if (!sentence) return null;
  return {
    id,
    title,
    icon,
    body: finishSentence(sentenceCase(stripTrailingPunctuation(sentence)), 180),
  };
}

function groupKey(source: OptionLike): string {
  return source.approachGroup ?? source.approachLabel ?? source.track ?? source.handle;
}

function stripGenericTitleSuffix(value: string): string {
  return value
    .replace(/\b(flow|route|path|idea|approach|option|strategy|experiment|prototype)\b$/i, '')
    .trim();
}

function fallbackIdeaTitle(...sources: Array<string | null | undefined>): string {
  for (const source of sources) {
    const sentence = firstSentence(source);
    if (!sentence) continue;

    const cleaned = sentence
      .replace(/^(try|trying|test|testing|explore|exploring|compare|comparing|build|building|create|creating|move|moving|keep|keeping|extend|extending|reuse|reusing|add|adding|remove|removing|choose|choosing)\s+/i, '')
      .replace(/^(a|an|the)\s+/i, '')
      .split(/\b(?:to|for|with|because|so that|which)\b/i)[0]
      .replace(/[.?!]+$/, '')
      .trim();

    const trimmed = stripGenericTitleSuffix(cleaned);
    if (!trimmed) continue;

    const words = trimmed.split(/\s+/).slice(0, 4).join(' ');
    const humanized = humanizeIdentifier(words);
    if (humanized) return humanized;
  }

  return 'Working Idea';
}

function optionTitle(source: OptionLike): string {
  return (
    humanizeIdentifier(source.approachLabel) ??
    humanizeIdentifier(source.approachGroup) ??
    humanizeIdentifier(source.track) ??
    fallbackIdeaTitle(source.mission, source.lastPost, source.handle)
  );
}

function resolveGroupBucket(group: OptionLike[]): BucketState {
  return [...group]
    .sort((a, b) => bucketPriority[a.bucket] - bucketPriority[b.bucket])[0]
    .bucket;
}

export function buildOptionCards(agents: AgentTile[]): OptionCardModel[] {
  const groups = new Map<string, AgentTile[]>();
  for (const agent of agents) {
    const key = groupKey(agent);
    const bucket = groups.get(key) ?? [];
    bucket.push(agent);
    groups.set(key, bucket);
  }

  return Array.from(groups.values())
    .map((group) => {
      const primary = group[0];
      const tone = resolveGroupBucket(group);
      return {
        id: groupKey(primary),
        title: optionTitle(primary),
        track: humanizeIdentifier(primary.track),
        status: bucketStatusCopy[tone].label,
        tone,
        summary: clampSentence(
          primary.mission,
          'This route still needs a clearer explanation.',
        ),
        nextStep: bucketStatusCopy[tone].next,
        latestNote: firstSentence(primary.lastPost),
        memberSentence:
          group.length === 1
            ? 'One agent is carrying this route.'
            : `${group.length} agents are carrying this route together.`,
      };
    })
    .sort((a, b) => bucketPriority[a.tone] - bucketPriority[b.tone]);
}

export function buildOverviewModel(sprint: SprintState | null): OverviewModel {
  if (!sprint) {
    return {
      phase: 'Idle',
      summary: 'There is no active sprint yet.',
      focus: 'Start a new sprint when you are ready to test a few clear routes.',
      recommendation: 'Begin with one focused question and only a small number of competing ideas.',
      optionCount: 0,
      needsInputCount: 0,
      readyCount: 0,
    };
  }

  const options = buildOptionCards(sprint.agents);
  const needsInputCount = options.filter((option) => option.tone === 'blocked').length;
  const readyCount = options.filter((option) => option.tone === 'review' || option.tone === 'done').length;
  const exploringCount = options.filter((option) => option.tone === 'in_progress').length;

  let phase = 'Exploring';
  if (sprint.status === 'compressing') phase = 'Synthesizing';
  else if (sprint.status === 'ready') phase = 'Decision ready';
  else if (needsInputCount > 0) phase = 'Needs clarity';

  let summary = `${options.length} route${options.length === 1 ? ' is' : 's are'} in play.`;
  if (needsInputCount > 0) {
    summary += ` ${needsInputCount} ${needsInputCount === 1 ? 'route needs' : 'routes need'} your input.`;
  } else if (readyCount > 0) {
    summary += ` ${readyCount} ${readyCount === 1 ? 'route is' : 'routes are'} ready to compare.`;
  } else if (exploringCount > 0) {
    summary += ` ${exploringCount} ${exploringCount === 1 ? 'route is' : 'routes are'} still being explored.`;
  }

  let focus = 'Keep the work narrow and let the current routes finish.';
  let recommendation = 'Stay with the current sprint until the signal is clearer.';

  if (needsInputCount > 0) {
    focus = 'Resolve the blocked question before adding more exploration.';
    recommendation = 'Clarify the blocked route first so the rest of the sprint can stay focused.';
  } else if (sprint.status === 'compressing') {
    focus = 'The system is condensing the explored routes into one cleaner result.';
    recommendation = 'Wait for synthesis to finish, then open the decision brief and choose what survives.';
  } else if (sprint.status === 'ready' || readyCount > 0) {
    focus = 'Enough signal exists to make a decision.';
    recommendation = 'Open the decision brief and keep only the clearest route.';
  }

  return {
    phase,
    summary,
    focus,
    recommendation,
    optionCount: options.length,
    needsInputCount,
    readyCount,
  };
}

function decisionStatusCopy(status: 'passed' | 'crashed' | 'running'): string {
  if (status === 'passed') return 'Holding up';
  if (status === 'crashed') return 'Not stable yet';
  return 'Still being tested';
}

function groupLandingAgents(agents: LandingBriefAgent[]): LandingBriefAgent[][] {
  const groups = new Map<string, LandingBriefAgent[]>();
  for (const agent of agents) {
    const key = agent.approachGroup ?? agent.approachLabel ?? agent.track ?? agent.handle;
    const bucket = groups.get(key) ?? [];
    bucket.push(agent);
    groups.set(key, bucket);
  }
  return Array.from(groups.values());
}

function groupDecisionTone(group: LandingBriefAgent[]): 'passed' | 'crashed' | 'running' {
  if (group.some((agent) => agent.status === 'passed')) return 'passed';
  if (group.some((agent) => agent.status === 'running')) return 'running';
  return 'crashed';
}

interface DecisionSignalGroup {
  id: string;
  tone: 'passed' | 'crashed' | 'running';
  title: string;
  hypothesis: string | null;
  whyAlive: string;
  whatItReuses: string | null;
  existingCodeGap: string | null;
  evidence: string | null;
  concern: string | null;
}

function buildDecisionSignalMap(brief: LandingBriefData | null): Map<string, DecisionSignalGroup> {
  const result = new Map<string, DecisionSignalGroup>();
  if (!brief) return result;

  for (const group of groupLandingAgents(brief.agents)) {
    const primary = group[0];
    const tone = groupDecisionTone(group);
    const report = primary.report;
    const id = primary.approachGroup ?? primary.handle;

    result.set(id, {
      id,
      tone,
      title:
        humanizeIdentifier(primary.approachLabel) ??
        humanizeIdentifier(primary.approachGroup) ??
        humanizeIdentifier(primary.track) ??
        fallbackIdeaTitle(report?.hypothesis, report?.summary, primary.mission, primary.handle),
      hypothesis: firstSentence(report?.hypothesis),
      whyAlive: clampSentence(
        report?.whySurvives ?? report?.summary ?? primary.mission,
        'This route still needs a clearer reason to stay alive.',
      ),
      whatItReuses: firstSentence(report?.reused),
      existingCodeGap: firstSentence(report?.whyNotExistingCode),
      evidence:
        firstSentence(report?.tests) ??
        (primary.testCount
          ? `${primary.testCount} check${primary.testCount === 1 ? '' : 's'} were reported for this route.`
          : null),
      concern:
        tone === 'crashed'
          ? 'This route is unstable and should stay discarded until it can prove itself.'
          : tone === 'running'
            ? 'This route still needs more proof before it can survive.'
            : null,
    });
  }

  return result;
}

function boardColumnFor(option: OptionCardModel, decision: DecisionSignalGroup | null): BoardColumnId {
  if (decision?.tone === 'passed') return 'survives';
  if (decision?.tone === 'crashed') return 'discarded';
  if (option.tone === 'blocked') return 'needs_input';
  if (option.tone === 'review' || option.tone === 'done') return 'ready_to_compare';
  return 'exploring';
}

function boardToneFor(option: OptionCardModel, decision: DecisionSignalGroup | null): BoardTone {
  if (decision?.tone) return decision.tone;
  return option.tone;
}

function boardRiskFor(option: OptionCardModel, decision: DecisionSignalGroup | null): string {
  if (decision?.concern) return decision.concern;
  if (option.tone === 'blocked') return 'It cannot move until a human answers the blocked question.';
  if (option.tone === 'review' || option.tone === 'done') {
    return 'It is ready to judge, so avoid expanding it before the comparison happens.';
  }
  if (option.tone === 'planning') return 'It is still loose, so the route could drift if we add more scope now.';
  return 'It is still early, so keep the route narrow until the current pass finishes.';
}

function boardNextMoveFor(option: OptionCardModel, decision: DecisionSignalGroup | null): string {
  if (decision?.tone === 'passed') {
    return 'Keep this route narrow and condense it into the smallest clear implementation.';
  }
  if (decision?.tone === 'crashed') {
    return 'Leave it discarded for now or retry it later with a tighter scope.';
  }
  return option.nextStep;
}

function boardSummaryFor(option: OptionCardModel, decision: DecisionSignalGroup | null): string {
  return cleanSentenceCore(decision?.hypothesis ?? option.summary, 'This idea still needs a clearer explanation');
}

function boardWhyAliveFor(option: OptionCardModel, decision: DecisionSignalGroup | null): string {
  return cleanSentenceCore(
    decision?.whyAlive ?? option.summary,
    'This idea still needs a clearer reason to stay alive',
  );
}

function boardLatestSignalFor(option: OptionCardModel, decision: DecisionSignalGroup | null): string {
  return cleanSentenceCore(
    decision?.evidence ?? option.latestNote ?? option.memberSentence,
    'Still gathering the first useful signal',
  );
}

function boardCardLineFor(
  option: OptionCardModel,
  decision: DecisionSignalGroup | null,
  column: BoardColumnId,
  risk: string,
): string {
  if (column === 'needs_input') {
    return (
      extractDecisionPrompt(decision?.existingCodeGap, option.latestNote, option.summary, risk) ??
      'Decide what this idea should do before work continues.'
    );
  }

  if (column === 'ready_to_compare') {
    return finishSentence(
      boardWhyAliveFor(option, decision),
      84,
    );
  }

  if (column === 'survives') {
    return finishSentence(
      `Chosen because ${lowerCaseFirst(ensureImplicitSubject(stripBecauseLead(boardWhyAliveFor(option, decision))))}`,
      84,
    );
  }

  if (column === 'discarded') {
    const reason = cleanSentenceCore(
      decision?.concern ?? option.latestNote ?? risk,
      'It did not earn survival',
    );
    return finishSentence(`Dropped because ${lowerCaseFirst(stripBecauseLead(reason))}`, 84);
  }

  const approach = cleanSentenceCore(option.summary, 'A possible direction');
  return finishSentence(`Testing ${lowerCaseFirst(stripActionLead(approach))}`, 84);
}

function boardDrawerOverviewFor(
  option: OptionCardModel,
  decision: DecisionSignalGroup | null,
  column: BoardColumnId,
  risk: string,
  nextMove: string,
): string {
  if (column === 'needs_input') {
    return combineSentences(
      extractDecisionPrompt(decision?.existingCodeGap, option.latestNote, option.summary, risk),
      risk,
    );
  }
  if (column === 'survives') {
    return combineSentences(decision?.whyAlive, nextMove);
  }
  if (column === 'discarded') {
    return combineSentences(decision?.concern ?? risk, nextMove);
  }
  return combineSentences(decision?.hypothesis ?? option.summary, decision?.whyAlive, risk);
}

function boardDrawerSectionsFor(
  option: OptionCardModel,
  decision: DecisionSignalGroup | null,
  column: BoardColumnId,
  summary: string,
  whyAlive: string,
  latestSignal: string,
  nextMove: string,
  risk: string,
): BoardDrawerSection[] {
  const sections: Array<BoardDrawerSection | null> = [];

  if (column === 'exploring') {
    sections.push(
      makeDrawerSection('trying', 'What this idea is trying', 'science', summary),
      makeDrawerSection('signal', 'Latest useful signal', 'query_stats', latestSignal),
      makeDrawerSection('survive', 'What would make it survive', 'favorite', whyAlive),
      makeDrawerSection('risk', 'What could kill it', 'warning', risk),
    );
  } else if (column === 'needs_input') {
    sections.push(
      makeDrawerSection(
        'decision',
        'Decision to make',
        'help',
        extractDecisionPrompt(decision?.existingCodeGap, option.latestNote, option.summary, risk),
      ),
      makeDrawerSection('why', 'Why this choice matters', 'balance', risk),
      makeDrawerSection('resume', 'What resumes after the decision', 'arrow_forward', nextMove),
    );
  } else if (column === 'ready_to_compare') {
    sections.push(
      makeDrawerSection('credible', 'Why this is credible', 'verified', whyAlive),
      makeDrawerSection('evidence', 'Best evidence', 'query_stats', latestSignal),
      makeDrawerSection('tradeoff', 'Main tradeoff', 'warning', risk),
      makeDrawerSection(
        'compare',
        'What to compare it against',
        'balance',
        'Compare this idea against the other live options before expanding it further.',
      ),
    );
  } else if (column === 'survives') {
    sections.push(
      makeDrawerSection('won', 'Why it won', 'verified', whyAlive),
      makeDrawerSection('reuse', 'What it reuses', 'recycling', decision?.whatItReuses),
      makeDrawerSection('build', 'What gets built now', 'arrow_forward', nextMove),
      makeDrawerSection('risk', 'Open risks', 'warning', risk),
    );
  } else if (column === 'discarded') {
    sections.push(
      makeDrawerSection('dropped', 'Why it was left behind', 'archive', decision?.concern ?? risk),
      makeDrawerSection('learned', 'What we learned', 'lightbulb', latestSignal || summary),
      makeDrawerSection('revisit', 'What would need to change', 'restart_alt', nextMove),
    );
  }

  return sections.filter((section): section is BoardDrawerSection => section !== null);
}

export function buildBoardModel(
  sprint: SprintState | null,
  brief: LandingBriefData | null,
): BoardModel {
  const overview = buildOverviewModel(sprint);
  const optionCards = sprint ? buildOptionCards(sprint.agents) : [];
  const decisionSignals = buildDecisionSignalMap(brief);

  const tiles = optionCards.map<BoardTileModel>((option) => {
    const decision = decisionSignals.get(option.id) ?? null;
    const column = boardColumnFor(option, decision);
    const tone = boardToneFor(option, decision);
    const risk = boardRiskFor(option, decision);
    const nextMove = boardNextMoveFor(option, decision);
    const summary = boardSummaryFor(option, decision);
    const whyAlive = boardWhyAliveFor(option, decision);
    const latestSignal = boardLatestSignalFor(option, decision);
    const cardLine = boardCardLineFor(option, decision, column, risk);

    return {
      id: option.id,
      title: option.title,
      track: option.track,
      status: decision ? decisionStatusCopy(decision.tone) : option.status,
      column,
      tone,
      cardLine,
      summary,
      whyAlive,
      latestSignal,
      nextMove,
      risk,
      memberSentence: option.memberSentence,
      hypothesis: decision?.hypothesis ?? null,
      whatItReuses: decision?.whatItReuses ?? null,
      existingCodeGap: decision?.existingCodeGap ?? null,
      evidence: decision?.evidence ?? null,
      drawerLabel: drawerLabelFor(column),
      drawerOverview: boardDrawerOverviewFor(option, decision, column, risk, nextMove) || cardLine,
      drawerSections: boardDrawerSectionsFor(
        option,
        decision,
        column,
        summary,
        whyAlive,
        latestSignal,
        nextMove,
        risk,
      ),
      drawerObservation: latestSignal || nextMove || whyAlive || summary,
    };
  });

  const columns: BoardColumnModel[] = [
    {
      id: 'exploring',
      title: 'Exploring',
      stage: 'Observe',
      description: 'Routes are still gathering signal. Keep them light and comparative.',
      tiles: tiles.filter((tile) => tile.column === 'exploring'),
    },
    {
      id: 'needs_input',
      title: 'Needs input',
      stage: 'Orient blocked',
      description: 'A human decision is blocking progress. Resolve the question before more buildout.',
      tiles: tiles.filter((tile) => tile.column === 'needs_input'),
    },
    {
      id: 'ready_to_compare',
      title: 'Ready to compare',
      stage: 'Orient complete',
      description: 'These routes have enough proof to judge side by side now.',
      tiles: tiles.filter((tile) => tile.column === 'ready_to_compare'),
    },
    {
      id: 'survives',
      title: 'Survives',
      stage: 'Decide',
      description: 'The clearest route earns continuation. Build only around this direction.',
      tiles: tiles.filter((tile) => tile.column === 'survives'),
    },
    {
      id: 'discarded',
      title: 'Discarded',
      stage: 'Closed',
      description: 'Explored routes that taught us something and did not earn survival.',
      tiles: tiles.filter((tile) => tile.column === 'discarded'),
    },
  ];

  return {
    headline: sprint?.goal ?? 'No active sprint',
    summary: overview.summary,
    stats: [
      {
        label: 'Routes in play',
        value: String(overview.optionCount),
        note: 'Different ideas currently on the board.',
      },
      {
        label: 'Need input',
        value: String(overview.needsInputCount),
        note: 'Routes waiting on your judgment.',
      },
      {
        label: 'Ready to compare',
        value: String(overview.readyCount),
        note: 'Routes with enough signal to judge now.',
      },
    ],
    columns,
  };
}

export function buildDecisionBriefModel(brief: LandingBriefData): DecisionBriefModel {
  const optionGroups = groupLandingAgents(brief.agents);
  const options = optionGroups.map((group) => {
    const primary = group[0];
    const tone = groupDecisionTone(group);
    const report = primary.report;
    const testSentence = primary.testCount
      ? `${primary.testCount} check${primary.testCount === 1 ? '' : 's'} were reported for this route.`
      : null;

    return {
      id: primary.approachGroup ?? primary.handle,
      title:
        humanizeIdentifier(primary.approachLabel) ??
        humanizeIdentifier(primary.approachGroup) ??
        humanizeIdentifier(primary.track) ??
        fallbackIdeaTitle(report?.hypothesis, report?.summary, primary.mission, primary.handle),
      status: decisionStatusCopy(tone),
      tone,
      verdict:
        tone === 'passed'
          ? 'This route is a credible survivor.'
          : tone === 'running'
            ? 'This route is still being explored.'
            : 'This route is not stable enough to keep yet.',
      whyItMatters:
        clampSentence(
          report?.whySurvives ?? report?.summary ?? primary.mission,
          'This route still needs a clearer reason to survive.',
        ),
      whatItReuses: firstSentence(report?.reused),
      existingCodeGap: firstSentence(report?.whyNotExistingCode),
      evidence: firstSentence(report?.tests) ?? testSentence,
      concern:
        tone === 'crashed'
          ? 'It failed during the sprint and needs a cleaner retry before it can survive.'
          : tone === 'running'
            ? 'It is still incomplete, so it should not be treated as the final choice yet.'
            : null,
    };
  });

  const recommended = options.find((option) => option.tone === 'passed') ?? null;
  let headline = 'Nothing is ready to keep yet.';
  let recommendation = 'Keep exploring until one route clearly earns the right to survive.';

  if (brief.compression?.status === 'compressing' || brief.sprint.status === 'compressing') {
    headline = 'The explored routes are being condensed into one clearer result.';
    recommendation = 'Wait for synthesis to finish, then choose the smallest route that still holds up.';
  } else if (brief.compression?.status === 'failed') {
    headline = 'The synthesis pass did not finish cleanly.';
    recommendation = 'Review the routes carefully before bypassing the failed synthesis pass.';
  } else if (recommended) {
    headline = `${recommended.title} is the clearest route right now.`;
    recommendation = `Keep ${recommended.title} and discard the weaker routes unless new evidence changes the picture.`;
  }

  let compressionNote: string | null = null;
  if (brief.compression) {
    const reduction = Math.round(brief.compression.ratio * 100);
    if (brief.compression.status === 'ready') {
      compressionNote = `The synthesis pass reduced the surviving change by ${reduction}%.`;
    } else if (brief.compression.status === 'bypassed' && brief.compression.bypassReason) {
      compressionNote = `The sprint was bypassed without a clean synthesis pass: ${brief.compression.bypassReason}`;
    } else if (brief.compression.errorMessage) {
      compressionNote = brief.compression.errorMessage;
    }
  }

  return {
    headline,
    recommendation,
    compressionNote,
    options,
  };
}

export function formatRelativeTime(dateStr: string): string {
  const diff = Date.now() - new Date(dateStr).getTime();
  const mins = Math.max(0, Math.floor(diff / 60000));
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function channelLabel(channel: string): string {
  if (channel === '#escalations') return 'Needs input';
  if (channel === '#status') return 'Status';
  return 'Progress';
}

function timelineSentence(post: FeedPost): string {
  if (post.channel === '#escalations') {
    return `Asked for input: ${post.content}`;
  }
  if (post.channel === '#status') {
    return post.content;
  }
  return `Shared progress: ${post.content}`;
}

export function buildTimelineEntries(posts: FeedPost[]): TimelineEntryModel[] {
  return posts.map((post) => ({
    id: post.id,
    label: channelLabel(post.channel),
    actor: humanizeIdentifier(post.author) ?? 'Unknown',
    sentence: timelineSentence(post),
    time: formatRelativeTime(post.created_at),
  }));
}

export function humanizeScope(scope: string): string {
  return scope
    .split(',')
    .map((part) => {
      const cleaned = part
        .trim()
        .replace(/^\.\//, '')
        .replace(/\/+$/, '')
        .replace(/\*+/g, '')
        .trim();
      if (!cleaned) return null;
      return cleaned
        .split('/')
        .map((segment) => {
          const lower = segment.toLowerCase();
          if (lower === 'src') return 'product code';
          if (lower === 'frontend') return 'interface';
          if (lower === 'backend') return 'server';
          if (lower === 'tests' || lower === '__tests__') return 'test coverage';
          if (lower === 'docs') return 'documentation';
          return humanizeIdentifier(segment) ?? segment;
        })
        .join(', ');
    })
    .filter(Boolean)
    .join(', ');
}
