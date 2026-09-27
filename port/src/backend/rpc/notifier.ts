// Renderer push channel: the port's EVT_Com.Notification → HandleEvent.method_0 path (05 §2.4, 02 §6).
//
// Vendor emitters build `new JsonResult { FunctionName = Notification_Func.X.ToString(), Tag = payload }`
// (e.g. DisplayFuncConstraints.Notify, AmbiScapeOper.method_1), i.e. err_code 0, err_msg null and
// RequestId null — the renderer tells notifications from replies only by the missing RequestId
// (02 §4.5). HandleEvent serializes that object with JsonSerialize() and sends it to every hub client
// as target "Notification". This class produces the same string and hands it to its subscribers
// (the hub server, via Backend.onNotification).

import type { Logger, Notifier } from '../types.ts';
import { SUCC, result, serializeResult } from '../core/envelope.ts';

/** HandleEvent.method_0 logs the payload only up to this many characters. */
export const NOTIFICATION_LOG_LIMIT = 1024;

export class HubNotifier implements Notifier {
  readonly #log: Logger;
  readonly #subscribers = new Set<(json: string) => void>();

  constructor(log: Logger) {
    this.#log = log;
  }

  notify(functionName: string, tag: unknown): void {
    let json: string;
    try {
      json = serializeResult({ ...result(SUCC, null, tag), FunctionName: functionName });
    } catch (e) {
      this.#log.error(`notification ${functionName} could not be serialized; dropped`, e);
      return;
    }
    const shown = json.length <= NOTIFICATION_LOG_LIMIT ? json : "'The parameter exceeds the print limit'";
    this.#log.debug(`OnNotification subscribers=${this.#subscribers.size} param=${shown}`);
    for (const deliver of [...this.#subscribers]) {
      try {
        deliver(json);
      } catch (e) {
        this.#log.error(`notification subscriber failed for ${functionName}`, e);
      }
    }
  }

  /** Receive every notification as its serialized JsonResult string; returns an unsubscribe function. */
  subscribe(deliver: (json: string) => void): () => void {
    this.#subscribers.add(deliver);
    return () => {
      this.#subscribers.delete(deliver);
    };
  }
}
