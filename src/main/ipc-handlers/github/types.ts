/**
 * GitHub module types and interfaces
 */

export interface GitHubConfig {
  token: string;
  repo: string;
}

export interface GitHubAPIRepository {
  id: number;
  name: string;
  full_name: string;
  description?: string;
  html_url: string;
  default_branch: string;
  private: boolean;
  owner: { login: string; avatar_url?: string };
}
