const MAX_PREFACE_CHARACTERS = 120;
const INTERNAL_LANGUAGE_PATTERN = /\b(?:question id|askedQuestionId|field|json|schema|prompt|system message|tool|function)\b/i;
const COLLECTION_EXPLANATION_PATTERN = /\b(?:we collect|collect this|need this information|information so)\b/i;
const INSTRUCTION_PATTERN = /\b(?:please provide|you must|you need to|make sure|be sure to|required field)\b/i;
const AVAILABILITY_PREFACE_PATTERN = /\b(?:estimate availability|estimate appointments? are available|available monday|monday through friday)\b/i;

function clean(value) {
  return String(value ?? '').replace(/\s+/g, ' ').trim();
}

function serviceNames(core) {
  return Object.keys(core?.BUSINESS?.services || {}).map((value) => clean(value)).filter(Boolean);
}

function mentionsConfiguredService(core, value) {
  const text = clean(value).toLowerCase();
  return serviceNames(core).some((service) => text.includes(service.toLowerCase()));
}

function stripCanonicalQuestion(core, value, questionId, lead = {}) {
  let text = clean(value);
  if (!text) return '';

  const canonicalQuestions = [
    baseQuestionFor(core, questionId, lead),
    repeatQuestionFor(core, questionId),
  ]
    .map((question) => clean(question))
    .filter(Boolean)
    .sort((left, right) => right.length - left.length);

  for (const question of canonicalQuestions) {
    if (text.toLowerCase() === question.toLowerCase()) return '';
    if (text.toLowerCase().endsWith(question.toLowerCase())) {
      text = clean(text.slice(0, text.length - question.length));
      break;
    }
  }

  return text;
}

export function availabilityStatement(core) {
  return `Estimate appointments are available ${core.BUSINESS.estimateDays} from ${core.BUSINESS.earliestEstimateStart} through ${core.BUSINESS.latestEstimateStart}.`;
}

export function summaryStatement(lead = {}) {
  const notes = clean(lead.notes);
  const notesClause = notes && notes.toLowerCase() !== 'none'
    ? ` The additional notes are: ${notes}.`
    : ' There are no additional notes.';
  return `Let me read that back. I have ${clean(lead.name)} requesting ${clean(lead.service)} at ${clean(lead.projectLocation)}, with an estimate preferred for ${clean(lead.preferredDate)} at ${clean(lead.preferredTime)}.${notesClause}`;
}

export function baseQuestionFor(core, questionId, lead = {}) {
  const questions = {
    ask_estimate: 'Would you like to submit an estimate request?',
    continue_estimate: 'Would you like to continue your estimate request?',
    more_questions: `Do you have any more questions about ${core.BUSINESS.name}?`,
    service: 'What service do you need?',
    name: 'What is your full name?',
    project_location: 'What is the full address for the project?',
    preferred_date_time: `${availabilityStatement(core)} What is your preferred estimate date and time?`,
    notes: "Before I send the request, is there anything else you'd like the estimator to know about the project?",
    contact_consent: core.contactConsentQuestion,
    confirm_summary: `${summaryStatement(lead)} Does all of that sound right?`,
    clarify: "I'm sorry, I didn't catch that. Could you repeat that?",
  };
  return clean(questions[questionId]);
}

export function repeatQuestionFor(core, questionId) {
  const questions = {
    ask_estimate: 'Would you like to submit an estimate request?',
    continue_estimate: 'Would you like to continue your estimate request?',
    more_questions: `Do you have any more questions about ${core.BUSINESS.name}?`,
    service: 'What service do you need?',
    name: 'What is your full name?',
    project_location: 'What is the full address for the project?',
    preferred_date_time: 'What is your preferred estimate date and time?',
    notes: "Is there anything else you'd like the estimator to know about the project?",
    contact_consent: core.contactConsentQuestion,
    confirm_summary: 'Does all of that sound right?',
    clarify: "I'm sorry, I didn't catch that. Could you repeat that?",
  };
  return clean(questions[questionId]);
}

export function sanitizeIntakePreface(core, value, questionId) {
  if (questionId === 'service' || questionId === 'clarify' || questionId === 'confirm_summary') return '';

  const sentences = clean(value).match(/[^.!?]+[.!?]?/g) || [];
  let preface = clean(sentences
    .map((sentence) => clean(sentence))
    .filter((sentence) => sentence && !sentence.endsWith('?'))
    .join(' '));

  if (!preface) return '';
  if (INTERNAL_LANGUAGE_PATTERN.test(preface)) return '';
  if (COLLECTION_EXPLANATION_PATTERN.test(preface)) return '';
  if (INSTRUCTION_PATTERN.test(preface)) return '';
  if (mentionsConfiguredService(core, preface)) return '';
  if (questionId === 'preferred_date_time' && AVAILABILITY_PREFACE_PATTERN.test(preface)) return '';

  if (preface.length > MAX_PREFACE_CHARACTERS) {
    preface = clean(preface.slice(0, MAX_PREFACE_CHARACTERS).replace(/\s+\S*$/, ''));
  }

  if (!preface) return '';
  if (!/[.!]$/.test(preface)) preface = `${preface}.`;
  return preface;
}

export function assembleIntakeReply(core, modelReply, questionId, lead = {}) {
  const question = baseQuestionFor(core, questionId, lead);
  if (!question || questionId === 'none') return clean(modelReply);

  const preface = stripCanonicalQuestion(core, modelReply, questionId, lead);
  const safePreface = sanitizeIntakePreface(core, preface, questionId);
  return clean(safePreface ? `${safePreface} ${question}` : question);
}
