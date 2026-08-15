import { getRequestIdentity, type RequestIdentity } from "./identity";

export async function authenticateCaseRequest(request: Request): Promise<RequestIdentity | null> {
  return getRequestIdentity(request);
}
