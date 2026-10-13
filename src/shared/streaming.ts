/** Streaming service methods → index of their onDelta callback parameter (shared by IPC and the home server). */
export const STREAMING_METHODS: Record<string, number> = {
  aiSummarize: 2,
  aiDraftReply: 2,
  aiRewrite: 3,
  aiTranslate: 2,
  aiCompose: 2,
  aiAsk: 1,
}

/** Service methods that only make sense on the machine the user sits at (never forwarded to a server). */
export const LOCAL_ONLY_METHODS = new Set(['oauthLogin'])
