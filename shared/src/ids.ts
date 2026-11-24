/**
 * The shape of every id: a lowercase prefix, an underscore, then letters and digits
 * (e.g. "emp_k3x9f2ab71qz"). Ids are made on the server; the API rejects anything else.
 */
export const ID_PATTERN = /^[a-z]+_[a-z0-9]{1,40}$/;

export const isId = (value: unknown): value is string => typeof value === 'string' && ID_PATTERN.test(value);
