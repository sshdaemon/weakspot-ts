import { remote } from './mocked';

export function viaRemote(n: number): number {
  return remote(n) + 1;
}
