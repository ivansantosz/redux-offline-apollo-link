import pick from "lodash/pick";
import get from "lodash/get";
import { ApolloLink, Observable } from "apollo-link";
import {
  selectURI,
  selectHttpOptionsAndBody,
  fallbackHttpConfig,
  serializeFetchParameter,
  createSignalIfSupported,
  parseAndCheckHttpResponse
} from "apollo-link-http-common";
import { extractFiles } from "extract-files";

const reduxOfflineApolloLink = (
  {
    uri: fetchUri = "/graphql",
    fetch: linkFetch = fetch,
    fetchOptions,
    credentials,
    headers,
    includeExtensions
  } = {},
  store
) => {
  const linkConfig = {
    http: { includeExtensions },
    options: fetchOptions,
    credentials,
    headers
  };

  return new ApolloLink((operation, forward) => {
    const state = store.getState();
    const uri = selectURI(operation, fetchUri);
    const context = operation.getContext();
    const contextConfig = {
      http: context.http,
      options: context.fetchOptions,
      credentials: context.credentials,
      headers: context.headers
    };

    const isOnline = state.offline.online;

    const { options, body } = selectHttpOptionsAndBody(
      operation,
      fallbackHttpConfig,
      linkConfig,
      contextConfig
    );

    const { clone, files } = extractFiles(body);
    const payload = serializeFetchParameter(clone, "Payload");

    const reduxActionName = get(operation, "variables.actionType");
    const reduxCommitSuffix = get(
      operation,
      "options.variables.actionCommitSuffix",
      "COMMIT"
    );
    const reduxRollbackSuffix = get(
      operation,
      "options.variables.actionRollbackSuffix",
      "ROLLBACK"
    );

    if (files.size) {
      delete options.headers["content-type"];
      // GraphQL multipart request spec:
      // https://github.com/jaydenseric/graphql-multipart-request-spec

      const form = new FormData();
      form.append("operations", payload);
      const map = {};
      let i = 0;
      files.forEach(paths => {
        map[++i] = paths;
      });
      form.append("map", JSON.stringify(map));

      i = 0;
      files.forEach((paths, file) => {
        form.append(String(++i), file, file.name);
      });

      options.body = form;
    } else {
      options.body = payload;
    }

    const action = {
      type: reduxActionName,
      meta: {
        offline: {
          effect: {
            url: uri,
            method: "POST",
            body: options.body,
            headers: {
              "content-type": "multipart/form-data;"
            }
          },
          // action to dispatch when effect succeeds:
          commit: { type: `${reduxActionName}_${reduxCommitSuffix}` },
          // action to dispatch if network action fails permanently:
          rollback: { type: `${reduxActionName}_${reduxRollbackSuffix}` }
        }
      }
    };

    const requestAction = pick(action, ["type"]);
    const commitAction = get(action, "meta.offline.commit");
    const rollbackAction = get(action, "meta.offline.rollback");

    if (!reduxActionName) {
      throw new Error(
        `This custom link requires you to specify an \`options.variables.actionType\`
         to handle redux offline actions in the event the device is offline`
      );
    }

    if (!isOnline) {
      store.dispatch(action);
      return new Observable(observer => {
        const { controller /*, signal */ } = createSignalIfSupported();
        controller.abort();
      });
    }

    store.dispatch(requestAction);

    return new Observable(observer => {
      // Allow aborting fetch, if supported.
      const { controller, signal } = createSignalIfSupported();
      if (controller) {
        options.signal = signal;
      }

      linkFetch(uri, options)
        .then(response => {
          // Forward the response on the context.
          operation.setContext({ response });
          return response;
        })
        .then(parseAndCheckHttpResponse(operation))
        .then(result => {
          store.dispatch({
            ...commitAction,
            payload: result
          });
          observer.next(result);
          observer.complete();
        })
        .catch(error => {
          store.dispatch({
            ...rollbackAction,
            payload: error
          });

          if (error.name === "AbortError") {
            // Fetch was aborted.
            return;
          }

          if (error.result && error.result.errors && error.result.data) {
            // There is a GraphQL result to forward.
            observer.next(error.result);
          }

          observer.error(error);
        });

      // Cleanup function.
      return () => {
        // Abort fetch.
        if (controller) {
          controller.abort();
        }
      };
    });
  });
};

export { reduxOfflineApolloLink };
