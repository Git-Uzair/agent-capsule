// Specification: https://modelcontextprotocol.io/specification/2026-07-28/basic/patterns/mrtr (Checked: 2026-08-15)
// Elicitation:   https://modelcontextprotocol.io/specification/2026-07-28/client/elicitation (Checked: 2026-08-15)
//
// Every MRTR and elicitation member name the server speaks lives in this file, so a revision that
// renames one is a single-file edit and the tests assert against these constants rather than against
// literals of their own. Two things the plan left open were settled by reading the two pages above:
//
//   * `inputRequests` and `inputResponses` are *maps*, not arrays — "an `InputRequests` object is a
//     map of server-client requests. Keys are server-assigned string identifiers". The identifier
//     used here is the grant the question is about, which is what lets the retry's answers be matched
//     back to the grants the token was issued for.
//   * a value is a request object, `{ method, params }`, and the client answers with the matching
//     result — for `elicitation/create` an `ElicitResult`: `action` of `accept`, `decline` or
//     `cancel`, plus `content` on accept.

import { asRecord } from "../core/canonical.ts";
import { emptyDict } from "../security/store.ts";

/** `Result.resultType` for a request the server cannot finish without asking the user something. */
export const INPUT_REQUIRED = "input_required";
export const ELICITATION_METHOD = "elicitation/create";
/** The one property of the consent form: which of the three answers the user chose. */
export const DECISION_PROPERTY = "decision";

export const DECISION = {
  allowOnce: "allow-once",
  alwaysAllow: "always-allow",
  deny: "deny",
} as const;

export type Decision = (typeof DECISION)[keyof typeof DECISION];

const DECISIONS: readonly Decision[] = [DECISION.allowOnce, DECISION.alwaysAllow, DECISION.deny];

export type ElicitationRequest = {
  method: typeof ELICITATION_METHOD;
  params: Record<string, unknown>;
};

export type InputRequiredResult = {
  resultType: typeof INPUT_REQUIRED;
  inputRequests: Record<string, ElicitationRequest>;
  requestState: string;
};

function isDecision(value: unknown): value is Decision {
  return DECISIONS.includes(value as Decision);
}

/**
 * The consent question, one form per missing grant. Form mode is correct here and URL mode is not:
 * what is being collected is a yes or a no about this capsule's own capability, not a credential.
 * The three answers are an `enum`, so a client renders them as the choice they are instead of asking
 * a user to type one of them.
 */
export function buildInputRequired(grants: string[], requestState: string): InputRequiredResult {
  const inputRequests: Record<string, ElicitationRequest> = {};
  for (const grant of grants) {
    inputRequests[grant] = {
      method: ELICITATION_METHOD,
      params: {
        mode: "form",
        message: `This capsule needs your permission to use ${grant}. Allow it?`,
        requestedSchema: {
          type: "object",
          properties: {
            [DECISION_PROPERTY]: {
              type: "string",
              title: `Allow ${grant}`,
              description: "Allow this call only, allow every call from now on, or refuse.",
              enum: [...DECISIONS],
            },
          },
          required: [DECISION_PROPERTY],
        },
      },
    };
  }
  return { resultType: INPUT_REQUIRED, inputRequests, requestState };
}

/**
 * The user's answers, by the grant each one is about. Absent `inputResponses` is `undefined` — the
 * client is retrying without having asked anybody — while an answer the server cannot read is simply
 * left out of the map: the specification says to ignore what it does not recognise and to ask again
 * for what is still missing, which is what the caller then does. `decline` and `cancel` are both a
 * refusal; only `accept` carries a decision.
 *
 * The keys come off the wire, so the map is prototype-less: a grant called `__proto__` has to be an
 * ordinary missing key rather than a write to `Object.prototype`.
 */
export function readInputResponses(params: unknown): Record<string, Decision> | undefined {
  const responses = asRecord(asRecord(params)?.["inputResponses"]);
  if (responses === undefined) return undefined;

  const decisions = emptyDict<Decision>();
  for (const [id, value] of Object.entries(responses)) {
    const result = asRecord(value);
    const action = result?.["action"];
    if (action === "decline" || action === "cancel") {
      decisions[id] = DECISION.deny;
      continue;
    }
    const chosen = asRecord(result?.["content"])?.[DECISION_PROPERTY];
    if (action === "accept" && isDecision(chosen)) decisions[id] = chosen;
  }
  return decisions;
}
