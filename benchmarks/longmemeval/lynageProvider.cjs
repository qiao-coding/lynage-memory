// ---------------------------------------------------------------------------
// Lynage Memory Provider for Promptfoo (CJS wrapper)
//
// Promptfoo loads this via file://, it dynamically imports the pre-built
// Lynage modules and handles search + answer for each test question.
//
// Pre-requisite: setup.ts must be run first to create the DB.
// ---------------------------------------------------------------------------

const path = require('path');
const fs = require('fs');

const RESULTS_DIR = path.resolve(__dirname, 'results');
const STATE_PATH = path.join(RESULTS_DIR, '.lynage-setup-state.json');

// Load state
let state = null;
try {
  state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
} catch {
  console.error('❌ Setup state not found. Run: pnpm tsx benchmarks/longmemeval/setup.ts');
}

class LynageProvider {
  constructor(options = {}) {
    this.providerId = options.id || 'lynage-memory';
    this.config = options.config || {};
    this._memory = null;
    this._model = null;
  }

  id() {
    return this.providerId;
  }

  async _ensureMemory() {
    if (this._memory) return this._memory;

    // Dynamic import ESM modules from CJS
    const { createOpenAI } = await import('@ai-sdk/openai');
    const { generateText } = await import('ai');
    const { createLynageMemory } = await import('@lynage/storage-sqlite');
    const { AiSdkModel } = await import('@lynage/ai-sdk');

    const dbPath = this.config.dbPath || state?.dbPath;
    if (!dbPath) throw new Error('No dbPath configured');

    this._memory = createLynageMemory({
      model: new AiSdkModel(this._model || null, undefined, { useToolChoice: false }),
      dbPath,
    });

    this._generateText = generateText;
    this._AiSdkModel = AiSdkModel;
    this._createOpenAI = createOpenAI;
    return this._memory;
  }

  async callApi(prompt, context) {
    try {
      const vars = context?.vars || {};
      const query = vars.query || prompt;
      const sessionId = this.config.sessionId || state?.sessionId || 'longmemeval-s1';

      const memory = await this._ensureMemory();

      // Setup model if not done
      if (!this._generateText) {
        const { createOpenAI: co } = await import('@ai-sdk/openai');
        const { generateText: gt } = await import('ai');
        this._generateText = gt;
        const deepseek = co({ apiKey: process.env.DEEPSEEK_API_KEY, baseURL: 'https://api.deepseek.com/v1' });
        this._model = deepseek('deepseek-v4-flash');
        this._AiSdkModel = (await import('@lynage/ai-sdk')).AiSdkModel;
        this._memory = null; // force recreate with model
        return this.callApi(prompt, context); // retry with model
      }

      // Search
      const searchResult = await memory.search({ query, sessionId });

      // Open top candidates
      const contextParts = [];
      for (const cand of searchResult.candidates.slice(0, 4)) {
        const openResult = await memory.openSource(cand.contextId);
        if (openResult) {
          contextParts.push(
            openResult.messages.map(m => `[${m.role.toUpperCase()}] ${m.content}`).join('\n')
          );
        }
      }
      const retrievedContext = contextParts.join('\n\n---\n\n');

      // Generate answer
      const systemPrompt = retrievedContext
        ? `Answer based ONLY on the conversation history below. If the answer is not in the history, say "Not found in conversation history." Do NOT guess.\n\n--- History ---\n${retrievedContext}`
        : 'You have no conversation history. Answer that you do not have enough information.';

      const result = await this._generateText({
        model: this._model,
        prompt: query,
        system: systemPrompt,
        maxTokens: 200,
      });

      const usage = await result.usage;
      return {
        output: result.text,
        tokenUsage: {
          total: (usage?.promptTokens ?? 0) + (usage?.completionTokens ?? 0),
          prompt: usage?.promptTokens ?? 0,
          completion: usage?.completionTokens ?? 0,
        },
      };
    } catch (err) {
      return { output: `(error: ${err.message})` };
    }
  }
}

module.exports = LynageProvider;
