// What clients actually approve → the studio's default voice recommendation.
// A down backend is a 503, NOT an empty recommendation: swallowing the failure
// into {character_id: null} made "backend unreachable" indistinguishable from
// "no client has picked yet" — the honest-status rule applies to reads too.
import { proxyJson } from "@/lib/backend";

export async function GET() {
  return proxyJson(`/v1/reviews/preferred`);
}
