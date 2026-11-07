/**
 * dsh-code-review — model catalog and classification route resolution.
 *
 * The settings dialog needs the list of models DSH exposes, and the classifier
 * needs exactly one effective route. Both are derived from DSH services and
 * never persisted by this plugin except for the explicit user choice:
 * explicit plugin choice -> the model the requesting session is running
 * (modelSelection projection -> logged request header -> DSH default model).
 */

/**
 * @param {{ ctx: import('@deepseek-ai/cordis').Context, classifier: object, settings: object }} deps
 */
export function createModelCatalog(deps) {
  const { ctx, classifier, settings } = deps;

  const MODELS_CACHE_MS = 60_000;
  const routesCache = { at: 0, value: null };

  // ---- Effective classification route --------------------------------------

  /** The model route chosen in the plugin settings, when both fields are set. */
  function classifyRouteFromSettings(value) {
    if (value === null || typeof value !== 'object') return undefined;
    if (typeof value.provider !== 'string' || value.provider.length === 0) return undefined;
    if (typeof value.model !== 'string' || value.model.length === 0) return undefined;
    return { provider: value.provider, model: value.model };
  }

  /**
   * Expose the effective classification route so the settings dialog can name
   * it: the explicit plugin choice, else the model the requesting session runs
   * on, else the DSH default model. The persisted `provider` / `model` fields
   * stay untouched (the dialog needs the raw ids); labels are separate fields.
   */
  function withModelRoute(value, sessionId) {
    const defaultRoute = classifier.defaultRoute() ?? null;
    const sessionRoute = classifier.sessionRoute(sessionId) ?? defaultRoute;
    const selected = classifyRouteFromSettings(value) ?? null;
    const effective = selected ?? sessionRoute ?? null;
    const label = (route) => (route === null || route === undefined ? null : `${route.provider}/${route.model}`);
    return {
      ...value,
      effectiveModel: label(effective),
      defaultModel: label(defaultRoute),
      sessionModel: label(sessionRoute),
      selectedModel: label(selected),
    };
  }

  // ---- Model catalog for the settings dialog -------------------------------

  function withTimeout(promise, ms) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        timer.unref?.();
        reject(new Error('timeout'));
      }, ms);
      timer.unref?.();
      Promise.resolve(promise).then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  /** Route shape used by the dialog; always a fresh plain object or null. */
  function routeValue(route) {
    if (route === null || route === undefined) return null;
    return { provider: route.provider, model: route.model };
  }

  /** Make sure the dialog can display a route even when discovery omitted it. */
  function ensureRoute(routes, route) {
    if (route === null || route === undefined) return;
    if (routes.some((entry) => entry.provider === route.provider && entry.model === route.model)) return;
    routes.push({
      provider: route.provider,
      providerName: route.provider,
      model: route.model,
      name: route.model,
    });
  }

  /**
   * Every model the user can pick in DSH: one entry per registered provider route
   * and the models that route advertises. Discovery failures degrade to the
   * provider's current default instead of failing the dialog. Only the expensive
   * provider/model discovery is cached: the session route and the explicit
   * selection are resolved per request, so two conversations running different
   * models each default to their own model.
   */
  /**
   * Reasoning metadata for one exact route (DSH's model picker needs the same
   * ladder). Capability probing is optional: failures degrade to "no levels".
   */
  async function resolveReasoning(route) {
    const empty = { route: routeValue(route), efforts: [], defaultEffort: null };
    if (route === null || route === undefined) return empty;
    const llm = ctx.get('llm');
    if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return empty;
    try {
      const info = await withTimeout(llm.resolveModelInfo(route.provider, route.model), 5_000);
      const reasoning = info && typeof info === 'object' ? info.reasoning : undefined;
      const efforts = Array.isArray(reasoning && reasoning.efforts) ? reasoning.efforts : [];
      const seen = new Set();
      const normalized = [];
      for (const effort of efforts) {
        if (effort === null || typeof effort !== 'object') continue;
        if (typeof effort.id !== 'string' || effort.id.length === 0) continue;
        if (seen.has(effort.id)) continue;
        seen.add(effort.id);
        normalized.push({
          id: effort.id,
          name: typeof effort.name === 'string' && effort.name.length > 0 ? effort.name : effort.id,
          ...(typeof effort.description === 'string' && effort.description.length > 0 ? { description: effort.description } : {}),
        });
      }
      const defaultEffort = typeof (reasoning && reasoning.defaultEffort) === 'string'
        && seen.has(reasoning.defaultEffort) ? reasoning.defaultEffort : null;
      return { route: routeValue(route), efforts: normalized, defaultEffort };
    } catch {
      return empty;
    }
  }

  async function listModels(sessionId) {
    let routes = routesCache.value;
    if (routes === null || Date.now() - routesCache.at >= MODELS_CACHE_MS) {
      routes = await discoverRoutes();
      routesCache.value = routes;
      routesCache.at = Date.now();
    }
    const defaultRoute = classifier.defaultRoute() ?? null;
    const sessionRoute = classifier.sessionRoute(sessionId) ?? defaultRoute;
    const value = await settings.read();
    const selected = classifyRouteFromSettings(value) ?? null;
    const options = routes.slice();
    ensureRoute(options, sessionRoute);
    ensureRoute(options, selected);
    const effectiveRoute = selected ?? sessionRoute ?? defaultRoute;
    return {
      routes: options,
      defaultModel: routeValue(defaultRoute),
      sessionModel: routeValue(sessionRoute),
      selectedModel: routeValue(selected),
      reasoning: await resolveReasoning(effectiveRoute),
    };
  }

  async function discoverRoutes() {
    const llm = ctx.get('llm');
    const defaultRoute = classifier.defaultRoute();
    const routes = [];
    let providers = [];
    try {
      providers = llm?.listProviders?.() ?? [];
    } catch {
      providers = [];
    }
    if (Array.isArray(providers)) {
      for (const provider of providers) {
        const providerId = provider !== null && typeof provider === 'object' && typeof provider.id === 'string' ? provider.id : null;
        if (providerId === null) continue;
        let models = [];
        try {
          models = await withTimeout(llm.listModels(providerId), 5_000);
        } catch {
          models = [];
        }
        if (!Array.isArray(models) || models.length === 0) {
          if (defaultRoute !== null && defaultRoute !== undefined && defaultRoute.provider === providerId) {
            models = [{ id: defaultRoute.model, name: defaultRoute.model }];
          }
        }
        for (const model of Array.isArray(models) ? models : []) {
          const modelId = model !== null && typeof model === 'object' && typeof model.id === 'string' ? model.id : null;
          if (modelId === null) continue;
          routes.push({
            provider: providerId,
            providerName: typeof provider.name === 'string' && provider.name.length > 0 ? provider.name : providerId,
            model: modelId,
            name: typeof model.name === 'string' && model.name.length > 0 ? model.name : modelId,
          });
        }
      }
    }
    if (routes.length === 0 && defaultRoute !== null && defaultRoute !== undefined) {
      routes.push({
        provider: defaultRoute.provider,
        providerName: defaultRoute.provider,
        model: defaultRoute.model,
        name: defaultRoute.model,
      });
    }
    return routes;
  }

  return { classifyRouteFromSettings, withModelRoute, listModels };
}
