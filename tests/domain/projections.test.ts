import { describe, expect, it } from 'vitest'

import {
  projectAttempt,
  projectNoCase,
  projectNotStarted,
  type ActiveAttempt,
  type PrivateAttemptRecord,
  type PrivateCaseFile,
  type TerminalAttempt,
} from '../../packages/domain/src/index.js'

const privateEvidence = <L extends 1 | 2 | 3 | 4>(level: L) => ({
  level,
  text: `evidence-${level}`,
  explanation: `secret-explanation-${level}`,
  sourceReferences: [`internal-source-${level}`],
})

const richAnswerSuggestion = {
  entityId: 'entity-answer',
  canonicalName: 'Answer Person',
  publicRole: 'Archivist',
  aliases: ['The Archivist'],
  isAnswer: true,
  answerEntityId: 'entity-answer',
  internalMetadata: { sourceReferences: ['suggestion-secret-source'] },
}

const privateCase: PrivateCaseFile = {
  slotId: 'slot-2026-09-12',
  revisionId: 'private-revision-7',
  opensAt: '2026-09-12T00:00:00.000Z',
  closesAt: '2026-09-13T00:00:00.000Z',
  briefing: 'A private-free abstract briefing.',
  suggestions: [
    richAnswerSuggestion,
    {
      entityId: 'entity-wrong',
      canonicalName: 'Other Person',
      publicRole: 'Keeper',
      aliases: [],
    },
  ],
  answerEntityId: 'entity-answer',
  evidence: [
    privateEvidence(1),
    privateEvidence(2),
    privateEvidence(3),
    privateEvidence(4),
  ],
}

const activeAttempt: ActiveAttempt = {
  state: 'ACTIVE',
  evidenceLevel: 2,
  wrongGuessesAtLevel: 1,
  totalWrongGuesses: 4,
}

const record = (
  attempt: ActiveAttempt | TerminalAttempt,
): PrivateAttemptRecord => ({
  attemptId: 'attempt-owned',
  ownerGuestId: 'guest-secret',
  slotId: privateCase.slotId,
  revisionId: privateCase.revisionId,
  version: 5,
  startedAt: '2026-09-12T00:01:00.000Z',
  snapshotAt: '2026-09-12T00:02:00.000Z',
  attempt,
  guesses: [
    {
      guessId: 'guess-secret',
      guestId: 'guest-secret',
      entityId: 'entity-wrong',
      guessedAt: '2026-09-12T00:01:30.000Z',
    },
  ],
})

function nestedKeys(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(nestedKeys)
  if (typeof value !== 'object' || value === null) return []

  return Object.entries(value).flatMap(([key, nested]) => [
    key,
    ...nestedKeys(nested),
  ])
}

describe('public case projections', () => {
  it('represents no-case without accepting private content', () => {
    expect(projectNoCase()).toEqual({ view: 'NO_CASE' })
  })

  it('allowlists only public slot fields before start', () => {
    expect(projectNotStarted(privateCase)).toEqual({
      view: 'NOT_STARTED',
      slotId: privateCase.slotId,
      opensAt: privateCase.opensAt,
      closesAt: privateCase.closesAt,
    })
  })

  it('exposes evidence one through e and own public history for ACTIVE (B13)', () => {
    const projection = projectAttempt(
      privateCase,
      {
        ...record(activeAttempt),
        attempt: activeAttempt,
      },
      'guest-secret',
    )

    expect(projection).toMatchObject({
      view: 'ATTEMPT',
      state: 'ACTIVE',
      evidenceLevel: 2,
      wrongGuessesAtLevel: 1,
      totalWrongGuesses: 4,
      evidence: [
        { level: 1, text: 'evidence-1' },
        { level: 2, text: 'evidence-2' },
      ],
      guessHistory: [
        {
          entityId: 'entity-wrong',
          guessedAt: '2026-09-12T00:01:30.000Z',
        },
      ],
    })
    expect(JSON.stringify(projection)).not.toContain('secret-explanation')
    expect(JSON.stringify(projection)).not.toContain('internal-source')
    expect(JSON.stringify(projection)).not.toContain('evidence-3')
    expect(JSON.stringify(projection)).not.toContain('evidence-4')
    expect(JSON.stringify(projection)).not.toContain('private-revision')
    expect(JSON.stringify(projection)).not.toContain('guest-secret')
    expect(JSON.stringify(projection)).not.toContain('guess-secret')
    const keys = nestedKeys(projection)
    for (const forbiddenKey of [
      'answer',
      'answerEntityId',
      'isAnswer',
      'internalMetadata',
      'explanation',
      'sourceReferences',
      'revisionId',
      'ownerGuestId',
      'guestId',
      'guessId',
      'snapshotAt',
    ]) {
      expect(keys).not.toContain(forbiddenKey)
    }
  })

  it.each(['SOLVED', 'GIVEN_UP', 'EXPIRED'] as const)(
    'unseals the complete case file for terminal state %s',
    (state) => {
      const terminal: TerminalAttempt = { ...activeAttempt, state }
      const projection = projectAttempt(
        privateCase,
        {
          ...record(terminal),
          attempt: terminal,
        },
        'guest-secret',
      )

      expect(projection.answer.entityId).toBe('entity-answer')
      expect(projection.evidence).toHaveLength(4)
      expect(projection.evidence.map((item) => item.explanation)).toEqual([
        'secret-explanation-1',
        'secret-explanation-2',
        'secret-explanation-3',
        'secret-explanation-4',
      ])
      expect(
        projection.evidence.flatMap((item) => item.sourceReferences),
      ).toEqual([
        'internal-source-1',
        'internal-source-2',
        'internal-source-3',
        'internal-source-4',
      ])
      expect(JSON.stringify(projection)).not.toContain('guest-secret')
      expect(JSON.stringify(projection)).not.toContain('private-revision')
    },
  )

  it('unseals an exhausted case without evidence level five', () => {
    const exhausted = {
      state: 'EXHAUSTED',
      evidenceLevel: 4,
      wrongGuessesAtLevel: 2,
      totalWrongGuesses: 15,
    } as const
    const projection = projectAttempt(
      privateCase,
      {
        ...record(exhausted),
        attempt: exhausted,
      },
      'guest-secret',
    )

    expect(projection.evidence).toHaveLength(4)
    expect(projection.state).toBe('EXHAUSTED')
  })

  it('rejects terminal projection when the answer is outside the public catalog', () => {
    const terminal = { ...activeAttempt, state: 'SOLVED' } as const
    expect(() =>
      projectAttempt(
        { ...privateCase, answerEntityId: 'unknown-answer' },
        { ...record(terminal), attempt: terminal },
        'guest-secret',
      ),
    ).toThrow('answerEntityId must identify a public suggestion')
  })

  it('rejects projection for a different guest', () => {
    expect(() =>
      projectAttempt(
        privateCase,
        { ...record(activeAttempt), attempt: activeAttempt },
        'other-guest',
      ),
    ).toThrow('attempt does not belong to the requesting guest')
  })

  it.each(['ACTIVE', 'SOLVED'] as const)(
    'rejects a %s attempt paired with a different revision',
    (state) => {
      const attempt = { ...activeAttempt, state }
      expect(() =>
        projectAttempt(
          { ...privateCase, revisionId: 'different-revision' },
          { ...record(attempt), attempt },
          'guest-secret',
        ),
      ).toThrow('attempt does not reference the supplied case revision')
    },
  )

  it('rejects an attempt paired with a different slot', () => {
    expect(() =>
      projectAttempt(
        { ...privateCase, slotId: 'different-slot' },
        { ...record(activeAttempt), attempt: activeAttempt },
        'guest-secret',
      ),
    ).toThrow('attempt does not reference the supplied case revision')
  })

  it('fails closed when private evidence is out of order', () => {
    const outOfOrder = [
      privateCase.evidence[3],
      privateCase.evidence[1],
      privateCase.evidence[2],
      privateCase.evidence[0],
    ] as unknown as PrivateCaseFile['evidence']

    expect(() =>
      projectAttempt(
        { ...privateCase, evidence: outOfOrder },
        { ...record(activeAttempt), attempt: activeAttempt },
        'guest-secret',
      ),
    ).toThrow('evidence must contain ordered levels one through four')
  })

  it("rejects another guest's guess mixed into owned history", () => {
    const ownedRecord = record(activeAttempt)
    const foreignGuess = { ...ownedRecord.guesses[0]!, guestId: 'other-guest' }

    expect(() =>
      projectAttempt(
        privateCase,
        {
          ...ownedRecord,
          attempt: activeAttempt,
          guesses: [foreignGuess],
        },
        'guest-secret',
      ),
    ).toThrow('guess history contains another guest')
  })
})
