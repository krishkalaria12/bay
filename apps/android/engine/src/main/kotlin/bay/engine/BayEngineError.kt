package bay.engine

/** A failure JavaScript sees as a rejected promise with this code and message. */
internal data class BayEngineError(val code: String, val message: String, val cause: Throwable? = null)
