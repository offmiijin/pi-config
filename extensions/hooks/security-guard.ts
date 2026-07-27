import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

type Mode = "interactive" | "strict" | "permissive" | "audit-only";

interface SecurityConfig {
  mode: Mode;
}

const SENSITIVE_PATTERNS: { pattern: RegExp; severity: string; reason: string }[] = [
  { pattern: /\brm\s+(-rf?|--recursive)\s+(\/|--no-preserve-root)/i, severity: "critical", reason: "rm -rf no diretório raiz" },
  { pattern: /\brm\s+(-rf?|--recursive)\s+\/\s*$/i, severity: "critical", reason: "rm -rf no diretório raiz" },
  { pattern: /\bdangerouslyRm/i, severity: "critical", reason: "Script de remoção perigosa" },
  { pattern: /\bsudo\s+rm\s+(-rf?)/i, severity: "critical", reason: "sudo com rm recursivo" },
  { pattern: /\bmkfs\b/, severity: "critical", reason: "Formatação de filesystem (mkfs)" },
  { pattern: /\bdd\b.*\bof=\/dev\/(sda|sdb|sdc|nvme|mmcblk|vd)/i, severity: "critical", reason: "dd direto para dispositivo de bloco" },
  { pattern: /\bshred\b/, severity: "critical", reason: "Destruição segura de arquivos (shred)" },
  { pattern: /\bwipefs\b/, severity: "critical", reason: "Remoção de assinatura de filesystem (wipefs)" },
  { pattern: /\bmkswap\b/, severity: "critical", reason: "Criação/formatação de swap" },
  { pattern: /\bparted\b.*\brm\b/, severity: "critical", reason: "Remoção de partição" },
  { pattern: /\bfdisk\b.*\b\/dev\//i, severity: "high", reason: "Manipulação de tabela de partições" },
  { pattern: /\b:\(\)\{ :\|: &\}\;:/, severity: "critical", reason: "Fork bomb" },
  // =================== GIT ===================
  { pattern: /\bgit\s+push\b[\s\S]*?\b(main|master)\b/, severity: "critical", reason: "Push direto para branch main/master" },

  { pattern: /\bsudo\s+(chmod|chown)\s+-R\s+777\s+\//i, severity: "critical", reason: "sudo chmod/chown -R 777 na raiz" },
  { pattern: /\bsudo\s+(chmod|chown)\s+-R\s+(777|root)\s+\//i, severity: "critical", reason: "sudo chmod/chown recursivo na raiz" },
  { pattern: /\bchmod\s+-R\s+777\s+\/\s*/i, severity: "high", reason: "chmod -R 777 na raiz" },
  { pattern: /\bchown\s+-R\s+[^:]*:\s*\//i, severity: "high", reason: "chown -R na raiz" },

  { pattern: /\b>\s*\/dev\/(sda|sdb|sdc|nvme|mmcblk|vd)/i, severity: "critical", reason: "Redirecionamento direto para dispositivo" },
  { pattern: /\bdangerouslyWriteTo/i, severity: "critical", reason: "Escrita perigosa em dispositivo" },
  { pattern: /\becho\s+['`].*['`]\s*>\s*\/dev\//i, severity: "critical", reason: "Escrita em dispositivo via echo" },

  { pattern: /\bcryptsetup\s+(luksFormat|erase)/i, severity: "critical", reason: "Formatação criptografada da partição" },
  { pattern: /\blvremove\b/, severity: "high", reason: "Remoção de volume lógico LVM" },
  { pattern: /\bvgremove\b/, severity: "high", reason: "Remoção de grupo de volumes LVM" },
  { pattern: /\bpvremove\b/, severity: "high", reason: "Remoção de volume físico LVM" },
  { pattern: /\bmdadm\b.*--(stop|remove|zero)/i, severity: "high", reason: "Manipulação de RAID" },

  { pattern: /\bpasswd\s+(root|--delete)/i, severity: "critical", reason: "Alteração de senha do root" },
  { pattern: /\buserdel\s+-r\b/i, severity: "high", reason: "Remoção de usuário com home" },
  { pattern: /\bgroupdel\b/i, severity: "medium", reason: "Remoção de grupo" },
  { pattern: /\busermod\s+-aG\s+sudo\b/i, severity: "high", reason: "Adição de usuário ao sudo" },
  { pattern: /\bvisudo\b/, severity: "high", reason: "Edição do sudoers" },
  { pattern: /\bsu\s+-\s*$/, severity: "medium", reason: "Troca para usuário (possível escalada)" },

  { pattern: /\biptables\s+-F\b/i, severity: "high", reason: "Limpeza de regras de firewall" },
  { pattern: /\biptables\s+-P\s+(INPUT|FORWARD|OUTPUT)\s+DROP/i, severity: "high", reason: "Bloqueio total de tráfego de rede" },
  { pattern: /\bkill\s+-9\s+-1\b/i, severity: "critical", reason: "Kill all processes (kill -9 -1)" },
  { pattern: /\bkillall5\b/, severity: "critical", reason: "Kill all processes (killall5)" },
  { pattern: /\breboot\b/i, severity: "high", reason: "Reinicialização do sistema" },
  { pattern: /\bshutdown\b/i, severity: "high", reason: "Desligamento do sistema" },
  { pattern: /\binit\s+0\b/i, severity: "high", reason: "Desligamento via init" },
  { pattern: /\binit\s+6\b/i, severity: "high", reason: "Reinicialização via init" },
  { pattern: /\bsystemctl\s+(poweroff|halt|reboot)/i, severity: "high", reason: "Gerenciamento de energia do sistema" },
  { pattern: /\bpoweroff\b/i, severity: "high", reason: "Desligamento" },
  { pattern: /\bhalt\b/i, severity: "medium", reason: "Parada do sistema" },

  { pattern: /\bwget\s+.*\s*\|\s*(bash|sh)\b/i, severity: "critical", reason: "Download e execução direta de script" },
  { pattern: /\bcurl\s+.*\s*\|\s*(bash|sh)\b/i, severity: "critical", reason: "Download e execução direta de script" },
  { pattern: /\bpip(3)?\s+install\s+--user\s+--upgrade\s+\w+/i, severity: "medium", reason: "Instalação de pacote sem verificação" },
  { pattern: /\bchmod\s+(\+x|[0-7]{3})\s+\/tmp\//i, severity: "medium", reason: "Execução de script em /tmp" },
  { pattern: /\beval\s+['`$]/, severity: "high", reason: "eval com entrada potencialmente insegura" },

  { pattern: /\bsource\s+\/dev\/stdin\b/i, severity: "critical", reason: "Source de stream externo" },
  { pattern: /\b(\.|source)\s+<(curl|wget)\b/i, severity: "critical", reason: "Source de download remoto" },
  { pattern: /\bbash\s+<(curl|wget)\b/i, severity: "critical", reason: "Bash subshell com download remoto" },

  { pattern: /\bpkexec\s+(rm|chmod|chown|mkfs|dd)/i, severity: "critical", reason: "Execução privilegiada de comando perigoso" },

  // =================== CONTAINER / ORCHESTRATION ===================
  { pattern: /\bdocker\s+(run|exec|create|start|build|commit|push|pull|login|attach|cp|export|import|load|save|tag|wait|kill|stop|restart|pause|unpause|rm|prune|system|volume|network|image|container|plugin|node|service|stack|swarm|config|secret|trust|search|buildx|compose|scan|context|manifest|app|sbom|deploy|init|extension)\b/i, severity: "critical", reason: "Execução dentro de container Docker bloqueada" },
  { pattern: /\bpodman\s+(run|exec|create|start|build|commit|push|pull|login|attach|cp|export|import|load|save|tag|wait|kill|stop|restart|pause|unpause|rm|prune|system|volume|network|image|container|pod|kube|play|generate|machine|farm|secret|manifest)\b/i, severity: "critical", reason: "Execução dentro de container Podman bloqueada" },
  { pattern: /\b(nerdctl|ctr)\s+(run|exec|create|start|attach|cp|kill|stop|rm|images|containers|namespaces)\b/i, severity: "critical", reason: "Execução dentro de container containerd bloqueada" },
  { pattern: /\bkubectl\s+(exec|run|attach|cp|port-forward|proxy)\b/i, severity: "critical", reason: "Execução dentro de pod Kubernetes bloqueada" },
  { pattern: /\bkubectl\s+(apply|create|delete|patch|replace|edit|scale|rollout|expose|debug|label|annotate|taint|drain|cordon|uncordon)\b/i, severity: "high", reason: "Gerenciamento de cluster Kubernetes" },
  { pattern: /\bhelm\s+(install|upgrade|rollback|uninstall|template|pull|push|repo|test|verify|package|lint|dependency)\b/i, severity: "high", reason: "Gerenciamento de releases Helm" },
  { pattern: /\b(docker-compose|docker compose)\s+(up|down|run|exec|build|push|pull|start|stop|restart|pause|unpause|kill|rm|config|create|scale)\b/i, severity: "critical", reason: "Execução via Docker Compose bloqueada" },
  { pattern: /\b(buildah|skopeo)\b/i, severity: "medium", reason: "Build/push de imagens container" },
  { pattern: /\blxc\s+(start|stop|restart|exec|attach|create|destroy|launch|copy|move|publish|snapshot|console|shell)\b/i, severity: "high", reason: "Execução dentro de container LXC bloqueada" },
  { pattern: /\bsystemd-nspawn\b|\bmachinectl\b/i, severity: "high", reason: "Execução via systemd-nspawn bloqueada" },
  { pattern: /\b(runc|crun|kata-runtime|gvisor)\b/i, severity: "medium", reason: "Container runtime bloqueado" },
];

const SENSITIVE_PATH_PATTERNS: { pattern: RegExp; severity: string; reason: string }[] = [
  // =================== CHAVES SSH E CONEXÃO REMOTA ===================
  { pattern: /\/\.ssh\//, severity: "critical", reason: "Chaves SSH e configuração" },
  { pattern: /\/\.gnupg\//, severity: "critical", reason: "Chaves GPG/PGP e configuração" },
  { pattern: /\/\.putty\//, severity: "critical", reason: "Chaves PuTTY" },
  { pattern: /\/\.p1\b/, severity: "critical", reason: "Chave privada SSH (.p1)" },
  { pattern: /\/\.ppk$/, severity: "critical", reason: "Chave PuTTY Private Key" },
  { pattern: /\/known_hosts$/, severity: "low", reason: "Lista de hosts conhecidos SSH" },
  { pattern: /\/authorized_keys$/, severity: "medium", reason: "Chaves autorizadas SSH" },
  { pattern: /\/config$.*\/\.ssh\//, severity: "high", reason: "Configuração SSH" },
  { pattern: /\/ssh_config$/, severity: "high", reason: "Configuração SSH do sistema" },
  { pattern: /\/ssh_host_/, severity: "critical", reason: "Chave de host SSH" },

  // =================== CERTIFICADOS E CHAVES CRIPTOGRÁFICAS ===================
  { pattern: /\.pem$/, severity: "critical", reason: "Chave/certificado (.pem)" },
  { pattern: /\.key$/, severity: "critical", reason: "Chave privada (.key)" },
  { pattern: /\.crt$/, severity: "high", reason: "Certificado SSL/TLS (.crt)" },
  { pattern: /\.cert$/, severity: "high", reason: "Certificado (.cert)" },
  { pattern: /\.cer$/, severity: "high", reason: "Certificado (.cer)" },
  { pattern: /\.p12$/, severity: "critical", reason: "PKCS#12 keystore" },
  { pattern: /\.pfx$/, severity: "critical", reason: "PKCS#12 keystore (.pfx)" },
  { pattern: /\.jks$/, severity: "critical", reason: "Java Keystore" },
  { pattern: /\.crl$/, severity: "medium", reason: "Lista de revogação de certificados" },
  { pattern: /\.csr$/, severity: "medium", reason: "Certificate Signing Request" },
  { pattern: /id_rsa$|id_dsa$|id_ecdsa$|id_ed25519$|id_xmss$/, severity: "critical", reason: "Chave privada SSH (id_*) " },

  // =================== NUVEM (CLOUD) ===================
  { pattern: /\/\.aws\//, severity: "high", reason: "Credenciais AWS" },
  { pattern: /\/\.aws\/credentials$/, severity: "critical", reason: "Credenciais AWS" },
  { pattern: /\/\.aws\/config$/, severity: "high", reason: "Configuração AWS" },
  { pattern: /\/\.config\/gcloud\//, severity: "high", reason: "Configuração Google Cloud (gcloud)" },
  { pattern: /\/\.gcp\/credentials/, severity: "critical", reason: "Credenciais GCP" },
  { pattern: /\/\.azure\//, severity: "high", reason: "Configuração Azure" },
  { pattern: /\/\.azure\/credentials$/, severity: "critical", reason: "Credenciais Azure" },
  { pattern: /\/\.azure\/accessTokens\.json$/, severity: "critical", reason: "Tokens de acesso Azure" },
  { pattern: /\/\.azure\/msal_token_cache\.json$/, severity: "critical", reason: "Cache de tokens Azure MSAL" },
  { pattern: /\/\.azure\/azureProfile\.json$/, severity: "high", reason: "Perfil Azure" },
  { pattern: /\/\.digitalocean\//, severity: "high", reason: "Configuração DigitalOcean" },
  { pattern: /\/\.doctl\//, severity: "high", reason: "Configuração DigitalOcean doctl" },
  { pattern: /\/\.oci\//, severity: "high", reason: "Configuração Oracle Cloud (OCI)" },
  { pattern: /\/\.hcloud\//, severity: "high", reason: "Configuração Hetzner Cloud" },
  { pattern: /\/\.scw\//, severity: "high", reason: "Configuração Scaleway" },
  { pattern: /\/\.vultr\//, severity: "high", reason: "Configuração Vultr" },
  { pattern: /\/\.linode\//, severity: "high", reason: "Configuração Linode" },
  { pattern: /\/\.fly\//, severity: "high", reason: "Configuração Fly.io" },
  { pattern: /\/\.railway\//, severity: "high", reason: "Configuração Railway" },
  { pattern: /\/\.vercel\//, severity: "high", reason: "Configuração Vercel" },
  { pattern: /\/\.netlify\//, severity: "high", reason: "Configuração Netlify" },
  { pattern: /\/\.now\//, severity: "high", reason: "Configuração Now/Ziet" },
  { pattern: /\/\.heroku\//, severity: "high", reason: "Configuração Heroku" },

  // =================== ORQUESTRAÇÃO E CONTAINER ===================
  { pattern: /\/\.kube\//, severity: "high", reason: "Configuração Kubernetes (kubectl)" },
  { pattern: /\/\.kube\/config$/, severity: "critical", reason: "Configuração Kubernetes com credenciais" },
  { pattern: /\/\.kube\/config-/, severity: "critical", reason: "Configuração alternativa Kubernetes" },
  { pattern: /\/\.minikube\//, severity: "medium", reason: "Configuração Minikube" },
  { pattern: /\/\.kind\//, severity: "medium", reason: "Configuração Kind" },
  { pattern: /\/\.docker\//, severity: "high", reason: "Configuração Docker" },
  { pattern: /\/\.docker\/config\.json$/, severity: "critical", reason: "Credenciais Docker (registry)" },
  { pattern: /\/\.docker\/daemon\.json$/, severity: "high", reason: "Configuração Docker daemon" },
  { pattern: /\/\.buildah\//, severity: "high", reason: "Configuração Buildah" },
  { pattern: /\/\.podman\//, severity: "high", reason: "Configuração Podman" },
  { pattern: /\/\.helm\//, severity: "high", reason: "Configuração Helm" },
  { pattern: /\/\.helm\/repository\//, severity: "medium", reason: "Repositórios Helm" },
  { pattern: /\/\.terraform\.d\//, severity: "high", reason: "Configuração Terraform" },
  { pattern: /\/\.terraform\.d\/plugin\//, severity: "low", reason: "Plugins Terraform" },
  { pattern: /\/terraform\.tfstate$/, severity: "critical", reason: "Estado Terraform (pode conter secrets)" },
  { pattern: /\/terraform\.tfvars$/, severity: "high", reason: "Variáveis Terraform (podem conter secrets)" },
  { pattern: /\/\.vagrant\.d\//, severity: "low", reason: "Configuração Vagrant" },
  { pattern: /\/Vagrantfile$/, severity: "low", reason: "Vagrantfile" },
  { pattern: /\/ansible\/vault\b/, severity: "critical", reason: "Ansible Vault" },
  { pattern: /\/vault\.yml$/, severity: "high", reason: "Ansible vault file" },
  { pattern: /\/\.vault-token/, severity: "critical", reason: "Token HashiCorp Vault" },

  // =================== CI/CD E PLATAFORMAS DE DEV ===================
  { pattern: /\/\.github\//, severity: "low", reason: "Configuração GitHub" },
  { pattern: /\/\.github\/workflows\//, severity: "low", reason: "GitHub Actions workflows" },
  { pattern: /\/\.gitlab-ci\.yml$/, severity: "low", reason: "GitLab CI config" },
  { pattern: /\/\.gitlab\//, severity: "low", reason: "Configuração GitLab" },
  { pattern: /\/\.circleci\//, severity: "low", reason: "Configuração CircleCI" },
  { pattern: /\/\.jenkins\//, severity: "high", reason: "Configuração Jenkins" },
  { pattern: /\/\.travis\.yml$/, severity: "low", reason: "Travis CI config" },
  { pattern: /\/\.drone\.yml$/, severity: "low", reason: "Drone CI config" },
  { pattern: /\/Jenkinsfile$/, severity: "low", reason: "Jenkins Pipeline" },

  // =================== GERENCIADORES DE PACOTE E REGISTRIES ===================
  { pattern: /\/\.npmrc\b/, severity: "high", reason: "Token NPM (registries)" },
  { pattern: /\/\.yarnrc\b/, severity: "high", reason: "Configuração Yarn" },
  { pattern: /\/\.yarnrc\.yml$/, severity: "high", reason: "Configuração Yarn (yml)" },
  { pattern: /\/\.pypirc$/, severity: "critical", reason: "Credenciais PyPI" },
  { pattern: /\/\.gem\/credentials$/, severity: "critical", reason: "Credenciais RubyGems" },
  { pattern: /\/\.cargo\/credentials$/, severity: "critical", reason: "Credenciais Cargo (Rust)" },
  { pattern: /\/\.cargo\/config\.toml$/, severity: "medium", reason: "Configuração Cargo" },
  { pattern: /\/\.ivy2\//, severity: "low", reason: "Cache Ivy/SBT" },
  { pattern: /\/\.sbt\//, severity: "low", reason: "Configuração SBT" },
  { pattern: /\/\.gradle\//, severity: "low", reason: "Cache Gradle" },
  { pattern: /\/gradle\/wrapper\/gradle-wrapper\.properties$/, severity: "low", reason: "Gradle wrapper properties" },
  { pattern: /\/nuget\.config$/, severity: "high", reason: "Configuração NuGet" },
  { pattern: /\/\.composer\/auth\.json$/, severity: "critical", reason: "Credenciais Composer (PHP)" },
  { pattern: /\/auth\.json$.*\.composer\//, severity: "critical", reason: "Autenticação Composer" },
  { pattern: /\/auth\.json$.*\/packagist\//, severity: "critical", reason: "Token Packagist" },
  { pattern: /\/\.hex\//, severity: "low", reason: "Configuração Hex (Elixir)" },
  { pattern: /\/mix\.exs$/, severity: "low", reason: "Mix config (Elixir)" },

  // =================== VERSIONAMENTO ===================
  { pattern: /\/\.git\/config$/, severity: "high", reason: "Configuração Git com credenciais" },
  { pattern: /\/\.git-credentials$/, severity: "critical", reason: "Credenciais Git armazenadas" },
  { pattern: /\/\.gitconfig\b/, severity: "medium", reason: "Configuração global Git" },
  { pattern: /\/\.gitignore$/, severity: "low", reason: "Gitignore" },
  { pattern: /\/\.gitattributes$/, severity: "low", reason: "Gitattributes" },
  { pattern: /\/\.svn\//, severity: "low", reason: "Subversion metadata" },
  { pattern: /\/\.hg\//, severity: "low", reason: "Mercurial metadata" },

  // =================== BANCO DE DADOS ===================
  { pattern: /\/\.mongodb\.conf$/, severity: "high", reason: "Configuração MongoDB" },
  { pattern: /\/mongod\.conf/, severity: "high", reason: "Configuração MongoDB" },
  { pattern: /\/mongo\/keyFile/, severity: "critical", reason: "Chave de autenticação MongoDB" },
  { pattern: /\/mysql\/my\.cnf$/, severity: "high", reason: "Configuração MySQL com credenciais" },
  { pattern: /\/\.my\.cnf$/, severity: "critical", reason: "Credenciais MySQL" },
  { pattern: /\/\.pgpass$/, severity: "critical", reason: "Credenciais PostgreSQL" },
  { pattern: /\/pg_hba\.conf$/, severity: "high", reason: "Configuração de autenticação PostgreSQL" },
  { pattern: /\/pg_ident\.conf$/, severity: "medium", reason: "Mapeamento de usuários PostgreSQL" },
  { pattern: /\/postgresql\.conf$/, severity: "high", reason: "Configuração PostgreSQL" },
  { pattern: /\/redis\.conf$/, severity: "high", reason: "Configuração Redis com senha" },
  { pattern: /\/\.redis_passwd$/, severity: "critical", reason: "Senha Redis" },
  { pattern: /\/\.elasticsearch\//, severity: "high", reason: "Configuração Elasticsearch" },
  { pattern: /\/elasticsearch\.yml$/, severity: "high", reason: "Configuração Elasticsearch" },

  // =================== VARIÁVEIS DE AMBIENTE E CONFIG ===================
  { pattern: /\/\.env(\.[a-zA-Z0-9_-]+)?$/, severity: "high", reason: "Arquivo de variáveis de ambiente" },
  { pattern: /\/\.env\.example$/, severity: "low", reason: "Exemplo de variáveis de ambiente" },
  { pattern: /\/\.env\.local$/, severity: "high", reason: "Variáveis de ambiente local" },
  { pattern: /\/\.env\.production$/, severity: "critical", reason: "Variáveis de ambiente de produção" },
  { pattern: /\/\.env\.prod$/, severity: "critical", reason: "Variáveis de ambiente de produção" },
  { pattern: /\/\.env\.staging$/, severity: "high", reason: "Variáveis de ambiente de staging" },
  { pattern: /\/\.env\.dev$/, severity: "medium", reason: "Variáveis de ambiente de dev" },
  { pattern: /\/env\.php$/, severity: "high", reason: "Arquivo env PHP" },
  { pattern: /\/application\.yml$/, severity: "medium", reason: "Configuração Spring Boot" },
  { pattern: /\/application-.*\.(yml|yaml|properties)$/, severity: "high", reason: "Configuração Spring Boot com credenciais" },
  { pattern: /\/bootstrap\.(yml|yaml|properties)$/, severity: "high", reason: "Configuração Spring Boot bootstrap" },
  { pattern: /\/secrets\.(yml|yaml|json|toml|ini)$/, severity: "critical", reason: "Arquivo de segredos" },
  { pattern: /\/secret\.(yml|yaml|json|toml|ini)$/, severity: "critical", reason: "Arquivo de segredos" },
  { pattern: /\/credentials\.(yml|yaml|json|toml|ini)$/, severity: "critical", reason: "Arquivo de credenciais" },
  { pattern: /\/config\.json$.*\/secrets?\//, severity: "critical", reason: "Configuração com segredos" },
  { pattern: /\/settings\.json$.*\/secrets?\//, severity: "critical", reason: "Configuração com segredos" },
  { pattern: /\/database\.yml$/, severity: "high", reason: "Configuração de banco de dados" },
  { pattern: /\/\.htpasswd$/, severity: "critical", reason: "Arquivo de senhas HTTP" },
  { pattern: /\/\.htaccess$/, severity: "low", reason: "Arquivo de configuração Apache" },
  { pattern: /\/wp-config\.php$/, severity: "critical", reason: "Configuração WordPress (credenciais DB)" },
  { pattern: /\/configuration\.php$/, severity: "high", reason: "Configuração PHP com credenciais" },

  // =================== HISTÓRICO E SESSÕES ===================
  { pattern: /\/\.bash_history$/, severity: "high", reason: "Histórico bash (pode conter secrets)" },
  { pattern: /\/\.zsh_history$/, severity: "high", reason: "Histórico zsh (pode conter secrets)" },
  { pattern: /\/\.sh_history$/, severity: "high", reason: "Histórico sh (pode conter secrets)" },
  { pattern: /\/\.history$/, severity: "high", reason: "Histórico shell (pode conter secrets)" },
  { pattern: /\/\.mysql_history$/, severity: "high", reason: "Histórico MySQL (credenciais em comandos)" },
  { pattern: /\/\.psql_history$/, severity: "high", reason: "Histórico PostgreSQL (credenciais)" },
  { pattern: /\/\.rediscli_history$/, severity: "high", reason: "Histórico Redis CLI" },
  { pattern: /\/\.node_repl_history$/, severity: "low", reason: "Histórico Node REPL" },
  { pattern: /\/\.python_history$/, severity: "medium", reason: "Histórico Python" },
  { pattern: /\/\.irb_history$/, severity: "medium", reason: "Histórico IRB (Ruby)" },
  { pattern: /\/\.lesshst$/, severity: "low", reason: "Histórico less" },
  { pattern: /\/\.viminfo$/, severity: "low", reason: "Informações Vim" },

  // =================== CREDENCIAIS E AUTENTICAÇÃO ===================
  { pattern: /\/\.netrc\b/, severity: "critical", reason: "Credenciais netrc" },
  { pattern: /\/\.netrc\.gpg$/, severity: "critical", reason: "Credenciais netrc criptografadas" },
  { pattern: /\/\.pgp\//, severity: "critical", reason: "Chaves PGP" },
  { pattern: /\/\.authinfo$/, severity: "critical", reason: "Informações de autenticação Emacs" },
  { pattern: /\/\.authinfo\.gpg$/, severity: "critical", reason: "Autenticação Emacs criptografada" },
  { pattern: /\/\.s3cfg$/, severity: "critical", reason: "Credenciais S3cmd" },
  { pattern: /\/\.s3backup$/, severity: "critical", reason: "Credenciais S3 backup" },
  { pattern: /\/\.boto$/, severity: "critical", reason: "Credenciais Boto (AWS Python)" },
  { pattern: /\/\.bucketeer$/, severity: "high", reason: "Configuração Bucketeer" },
  { pattern: /\/\.fog$/, severity: "high", reason: "Credenciais Fog (cloud)" },
  { pattern: /\/\.ovpn$/, severity: "high", reason: "Configuração VPN OpenVPN" },
  { pattern: /\/\.openvpn\//, severity: "high", reason: "Configuração OpenVPN" },
  { pattern: /\/\.wireguard\//, severity: "high", reason: "Configuração WireGuard" },
  { pattern: /\/wg[0-9]\.conf$/, severity: "high", reason: "Configuração WireGuard" },
  { pattern: /\/\.docker\/scan\//, severity: "low", reason: "Scan Docker" },
  { pattern: /\/\.docker\/buildx\//, severity: "low", reason: "Docker Buildx" },

  // =================== NPM / JavaScript / TypeScript ===================
  { pattern: /\/\.npm\//, severity: "medium", reason: "Cache e config NPM" },
  { pattern: /\/\.npm\/_cacache\//, severity: "low", reason: "Cache NPM" },
  { pattern: /\/\.npm\/_authToken$/, severity: "critical", reason: "Token de autenticação NPM" },
  { pattern: /\/\.nvm\//, severity: "low", reason: "Node Version Manager" },
  { pattern: /\/\.node-gyp\//, severity: "low", reason: "Node GYP" },

  // =================== EDITORES E IDE ===================
  { pattern: /\/\.vscode\//, severity: "low", reason: "Configuração VS Code" },
  { pattern: /\/\.vscode\/settings\.json$/, severity: "low", reason: "Configuração VS Code" },
  { pattern: /\/\.vscode\/extensions\.json$/, severity: "low", reason: "Extensões VS Code" },
  { pattern: /\/\.idea\//, severity: "low", reason: "Configuração JetBrains IDE" },
  { pattern: /\/\.idea\/workspace\.xml$/, severity: "medium", reason: "Workspace JetBrains (pode conter tokens)" },
  { pattern: /\/\.sublime\//, severity: "low", reason: "Configuração Sublime Text" },
  { pattern: /\/\.emacs\.d\//, severity: "low", reason: "Configuração Emacs" },
  { pattern: /\/\.vim\//, severity: "low", reason: "Configuração Vim" },
  { pattern: /\/\.vimrc$/, severity: "low", reason: "Vimrc" },
  { pattern: /\/\.tmux\.conf$/, severity: "low", reason: "Configuração Tmux" },
  { pattern: /\/\.config\/Code\//, severity: "low", reason: "Configuração VS Code (global)" },

  // =================== SISTEMA OPERACIONAL ===================
  { pattern: /\/etc\/shadow$/, severity: "critical", reason: "Senhas do sistema (/etc/shadow)" },
  { pattern: /\/etc\/shadow-/, severity: "critical", reason: "Backup de senhas do sistema" },
  { pattern: /\/etc\/gshadow$/, severity: "critical", reason: "Senhas de grupo do sistema" },
  { pattern: /\/etc\/passwd$/, severity: "high", reason: "Base de usuários (/etc/passwd)" },
  { pattern: /\/etc\/passwd-/, severity: "high", reason: "Backup de base de usuários" },
  { pattern: /\/etc\/sudoers$/, severity: "critical", reason: "Arquivo sudoers" },
  { pattern: /\/etc\/sudoers\.d\//, severity: "critical", reason: "Diretório sudoers" },
  { pattern: /\/etc\/ssh\//, severity: "critical", reason: "Configuração SSH do sistema" },
  { pattern: /\/etc\/ssl\//, severity: "high", reason: "Certificados SSL do sistema" },
  { pattern: /\/etc\/pam\.d\//, severity: "high", reason: "Configuração PAM" },
  { pattern: /\/etc\/security\//, severity: "high", reason: "Configuração de segurança" },
  { pattern: /\/etc\/selinux\//, severity: "medium", reason: "Configuração SELinux" },
  { pattern: /\/etc\/audit\//, severity: "medium", reason: "Configuração de auditoria" },
  { pattern: /\/etc\/fstab$/, severity: "low", reason: "Tabela de filesystems" },
  { pattern: /\/etc\/crypttab$/, severity: "high", reason: "Tabela de criptografia" },
  { pattern: /\/etc\/ldap\//, severity: "high", reason: "Configuração LDAP" },
  { pattern: /\/etc\/openldap\//, severity: "high", reason: "Configuração OpenLDAP" },
  { pattern: /\/etc\/nsswitch\.conf$/, severity: "low", reason: "Name Service Switch" },
  { pattern: /\/etc\/hosts\.(allow|deny)$/, severity: "low", reason: "Controle de acesso TCP wrappers" },
  { pattern: /\/etc\/resolv\.conf$/, severity: "low", reason: "Configuração DNS" },
  { pattern: /\/etc\/ntp\.conf$/, severity: "low", reason: "Configuração NTP" },
  { pattern: /\/etc\/crontab$/, severity: "medium", reason: "Crontab do sistema" },
  { pattern: /\/etc\/cron\.(d|daily|weekly|monthly)/, severity: "medium", reason: "Scripts cron do sistema" },
  { pattern: /\/var\/spool\/cron\//, severity: "high", reason: "Crons de usuários" },
  { pattern: /\/root\//, severity: "high", reason: "Home do root" },
  { pattern: /\/root\/\.ssh\//, severity: "critical", reason: "Chaves SSH do root" },
  { pattern: /\/\.bashrc$/, severity: "low", reason: "Bashrc" },
  { pattern: /\/\.zshrc$/, severity: "low", reason: "Zshrc" },
  { pattern: /\/\.profile$/, severity: "low", reason: "Profile shell" },
  { pattern: /\/\.login$/, severity: "low", reason: "Login script" },
  { pattern: /\/\.xsession$/, severity: "low", reason: "X session config" },

  // =================== LOGS ===================
  { pattern: /\/var\/log\/(auth|secure|audit)/, severity: "medium", reason: "Log de autenticação" },
  { pattern: /\/var\/log\/lastlog$/, severity: "low", reason: "Últimos logins" },
  { pattern: /\/var\/log\/wtmp$/, severity: "low", reason: "Registro de logins" },
  { pattern: /\/var\/log\/btmp$/, severity: "low", reason: "Tentativas de login falhas" },
  { pattern: /\/var\/log\/messages$/, severity: "low", reason: "Mensagens do sistema" },
  { pattern: /\/var\/log\/syslog$/, severity: "low", reason: "Syslog do sistema" },
  { pattern: /\/var\/log\/kern\.log$/, severity: "low", reason: "Log do kernel" },
  { pattern: /\/var\/log\/dmesg$/, severity: "low", reason: "Dmesg" },
  { pattern: /\/var\/log\/maillog$/, severity: "medium", reason: "Log de email" },
  { pattern: /\/var\/log\/apache2\/(access|error)\.log/, severity: "low", reason: "Log do Apache" },
  { pattern: /\/var\/log\/nginx\/(access|error)\.log/, severity: "low", reason: "Log do Nginx" },
  { pattern: /\/var\/log\/httpd\//, severity: "low", reason: "Log do Apache httpd" },
  { pattern: /\/var\/log\/mysql\.log$/, severity: "medium", reason: "Log MySQL" },
  { pattern: /\/var\/log\/mysqld\.log$/, severity: "medium", reason: "Log MySQL daemon" },
  { pattern: /\/var\/log\/postgresql\//, severity: "medium", reason: "Log PostgreSQL" },
  { pattern: /\/var\/log\/mongodb\//, severity: "medium", reason: "Log MongoDB" },
  { pattern: /\/var\/log\/redis\//, severity: "medium", reason: "Log Redis" },
  { pattern: /\/var\/log\/docker\//, severity: "low", reason: "Log Docker" },

  // =================== TOKENS E SEGREDOS DE APLICAÇÃO ===================
  { pattern: /\/token(s)?\.(txt|json|yml|yaml)$/, severity: "critical", reason: "Arquivo de token" },
  { pattern: /\/\.token$/, severity: "critical", reason: "Token de autenticação" },
  { pattern: /\/service_account\.json$/, severity: "critical", reason: "Conta de serviço GCP" },
  { pattern: /\/service-account\.json$/, severity: "critical", reason: "Conta de serviço" },
  { pattern: /\/client_secret\.json$/, severity: "critical", reason: "Client secret OAuth" },
  { pattern: /\/oauth\.(json|yml|yaml)$/, severity: "critical", reason: "Configuração OAuth" },
  { pattern: /\/google[a-zA-Z]*\.json$/, severity: "critical", reason: "Chave de API Google" },
  { pattern: /\/firebase[a-zA-Z]*\.json$/, severity: "critical", reason: "Chave Firebase" },
  { pattern: /\/firebase[a-zA-Z]*\.js$/, severity: "high", reason: "Configuração Firebase" },
  { pattern: /\/sentry[a-zA-Z]*\.(json|yml|yaml)$/, severity: "high", reason: "Configuração Sentry" },
  { pattern: /\/datadog[a-zA-Z]*\.(json|yml|yaml)$/, severity: "high", reason: "Configuração Datadog" },
  { pattern: /\/newrelic\.(yml|ini|json)$/, severity: "high", reason: "Configuração New Relic" },
  { pattern: /\/rollbar[a-zA-Z]*\.(json|yml|yaml)$/, severity: "high", reason: "Configuração Rollbar" },
  { pattern: /\/stripe[a-zA-Z]*\.(json|yml|yaml)$/, severity: "critical", reason: "Chave Stripe" },
  { pattern: /\/twilio[a-zA-Z]*\.(json|yml|yaml)$/, severity: "critical", reason: "Credenciais Twilio" },
  { pattern: /\/sendgrid[a-zA-Z]*\.(json|yml|yaml)$/, severity: "critical", reason: "Chave SendGrid" },
  { pattern: /\/mailgun[a-zA-Z]*\.(json|yml|yaml)$/, severity: "critical", reason: "Chave Mailgun" },
  { pattern: /\/jwt[a-zA-Z]*\.(key|pem|txt|json)$/, severity: "critical", reason: "Chave JWT" },
  { pattern: /\/slack[a-zA-Z]*\.(json|yml|yaml)$/, severity: "high", reason: "Token Slack" },
  { pattern: /\/discord[a-zA-Z]*\.(json|yml|yaml)$/, severity: "high", reason: "Token Discord" },
  { pattern: /\/github[a-zA-Z]*\.(json|yml|yaml)$/, severity: "high", reason: "Token GitHub" },
  { pattern: /\/gitlab[a-zA-Z]*\.(json|yml|yaml)$/, severity: "high", reason: "Token GitLab" },

  // =================== BACKUP / TEMP ===================
  { pattern: /\/\.(bak|backup)\/[^/]*\.(sql|dump|db|tar|gz)$/, severity: "high", reason: "Backup de dados (pode conter secrets)" },
  { pattern: /\/dump\.(sql|dump)$/i, severity: "high", reason: "Dump de banco de dados" },
  { pattern: /\/backup.*\.(sql|dump|tar|gz|zip)$/i, severity: "high", reason: "Backup (pode conter secrets)" },
  { pattern: /\/core\.\d+$/, severity: "low", reason: "Core dump" },

  // =================== SENHAS E CHAVES GERAIS ===================
  { pattern: /\/password(s)?\.(txt|json|yml|yaml|xml)$/i, severity: "critical", reason: "Arquivo de senha" },
  { pattern: /\/secret(s)?\.(txt|json|yml|yaml|xml|ini)$/i, severity: "critical", reason: "Arquivo de segredos" },
  { pattern: /\/\.secret(s)?$/i, severity: "critical", reason: "Arquivo oculto de segredos" },
  { pattern: /\/key\.(txt|json|yml|yaml)$/i, severity: "critical", reason: "Arquivo de chave" },
  { pattern: /\/keystore\.(jks|p12|pfx|bks)$/i, severity: "critical", reason: "Keystore" },
  { pattern: /\/truststore\.(jks|p12|pfx|bks)$/i, severity: "high", reason: "Truststore" },

  // =================== DIRETÓRIOS DEPRECADOS ===================
  { pattern: /\/deprecated(\/|$)/, severity: "high", reason: "Diretório deprecated — código legado, não ler" },

  // =================== GPG / CRIPTOGRAFIA ===================
  { pattern: /\/\.gnupg\/private-keys/, severity: "critical", reason: "Chave privada GPG" },
  { pattern: /\/\.gnupg\/secring\.gpg$/, severity: "critical", reason: "Chave secreta GPG" },
  { pattern: /\/\.gnupg\/pubring\.gpg$/, severity: "low", reason: "Chave pública GPG" },
  { pattern: /\/\.gnupg\/gpg\.conf$/, severity: "medium", reason: "Configuração GPG" },
  { pattern: /\/\.gnupg\/dirmngr\.conf$/, severity: "low", reason: "Configuração dirmngr" },

  // =================== SISTEMAS LEGADO ===================
  { pattern: /\/\.rhosts$/, severity: "critical", reason: "Rhosts (autenticação obsoleta)" },
  { pattern: /\/\.shosts$/, severity: "critical", reason: "Shosts (autenticação obsoleta)" },
  { pattern: /\/hosts\.equiv$/, severity: "high", reason: "Configuração de acesso equivalente" },
  { pattern: /\/\.Xauthority$/, severity: "medium", reason: "Cookie de autorização X11" },
  { pattern: /\/\.ICEauthority$/, severity: "medium", reason: "Cookie de autorização ICE" },
];

function getConfig(ctx: any): SecurityConfig {
  return { mode: (process.env.PI_SECURITY_MODE as Mode) ?? "interactive" };
}

function maskCommand(cmd: string): string {
  return cmd.replace(/(?<=API_KEY=|api_key=|token=|password=|secret=|key=|--password\s+|--token\s+)\S+/gi, "***");
}

async function logEvent(
  toolName: string,
  detail: string,
  blocked: boolean,
  ctx: any
) {
  if (ctx?.hasUI) {
    ctx.ui.notify(
      `[SEGURANÇA] ${detail}`,
      blocked ? "error" : "info"
    );
  }
}

async function handleBashCommand(
  command: string,
  ctx: any,
  config: SecurityConfig
): Promise<{ block: boolean; reason?: string } | undefined> {
  for (const entry of SENSITIVE_PATTERNS) {
    if (entry.pattern.test(command)) {
      const masked = maskCommand(command);

      await logEvent("bash", `${entry.reason}: ${masked}`, true, ctx);

      if (config.mode === "strict") {
        return { block: true, reason: `[BLOQUEADO] ${entry.reason}` };
      }

      if (config.mode === "audit-only") {
        return undefined;
      }

      if (config.mode === "permissive") {
        return undefined;
      }

      if (!ctx.hasUI) {
        return { block: true, reason: `[BLOQUEADO] ${entry.reason} (modo não-interativo)` };
      }

      const choice = await ctx.ui.select(
        `\u26A0\uFE0F Alerta de segurança (${entry.severity.toUpperCase()}):\n  ${entry.reason}\n\nComando: ${masked}`,
        ["Permitir esta vez", "Bloquear"]
      );

      if (choice === "Bloquear") {
        return { block: true, reason: `[BLOQUEADO PELO USUÁRIO] ${entry.reason}` };
      }

      await logEvent("bash", `${entry.reason}: ${masked} (permitido pelo usuário)`, false, ctx);
      return undefined;
    }
  }

  // Check for sensitive paths in any bash command (write, read, move, symlink, etc.)
  for (const entry of SENSITIVE_PATH_PATTERNS) {
    const src = entry.pattern.source;
    const relativeSrc = src.startsWith('\\/')
      ? '(?:^|[\\/\\s"\'\\\\<])' + src.slice(2).replace(/\$$/, '(?:[\\s\\)]|$)')
      : src.replace(/\$$/, '(?:[\\s\\)]|$)');
    const relativePattern = new RegExp(relativeSrc, entry.pattern.flags);

    if (relativePattern.test(command)) {
      await logEvent("bash", `${entry.reason}: ${command}`, true, ctx);

      if (config.mode === "strict") {
        return { block: true, reason: `[BLOQUEADO] ${entry.reason}: ${command}` };
      }
      if (config.mode === "audit-only" || config.mode === "permissive") {
        return undefined;
      }
      if (!ctx.hasUI) {
        return { block: true, reason: `[BLOQUEADO] ${entry.severity}: ${command} (modo não-interativo)` };
      }

      const choice = await ctx.ui.select(
        `\u26A0\uFE0F Operação em arquivo sensível (${entry.severity.toUpperCase()}):\n  ${entry.reason}\n\nComando: ${command}`,
        ["Permitir esta vez", "Bloquear"]
      );
      if (choice === "Bloquear") {
        return { block: true, reason: `[BLOQUEADO PELO USUÁRIO] ${entry.reason}` };
      }
      await logEvent("bash", `${entry.reason}: ${command} (permitido pelo usuário)`, false, ctx);
      return undefined;
    }
  }

  return undefined;
}

async function handlePathAccess(
  toolName: string,
  path: string,
  ctx: any,
  config: SecurityConfig
): Promise<{ block: boolean; reason?: string } | undefined> {
  for (const entry of SENSITIVE_PATH_PATTERNS) {
    if (entry.pattern.test(path)) {
      await logEvent(toolName, `${entry.reason}: ${path}`, true, ctx);

      if (config.mode === "strict") {
        return { block: true, reason: `[BLOQUEADO] ${entry.reason}: ${path}` };
      }

      if (config.mode === "audit-only" || config.mode === "permissive") {
        return undefined;
      }

      if (!ctx.hasUI) {
        return { block: true, reason: `[BLOQUEADO] ${entry.severity}: ${path} (modo não-interativo)` };
      }

      const isWrite = toolName === "write" || toolName === "edit";
      const actionLabel = isWrite ? "Escrita" : "Leitura";

      const choice = await ctx.ui.select(
        `\u26A0\uFE0F ${actionLabel} em área sensível (${entry.severity.toUpperCase()}):\n  ${entry.reason}\n\nArquivo: ${path}`,
        ["Permitir esta vez", "Bloquear"]
      );

      if (choice === "Bloquear") {
        return { block: true, reason: `[BLOQUEADO PELO USUÁRIO] ${entry.reason}` };
      }

      await logEvent(toolName, `${entry.reason}: ${path} (permitido pelo usuário)`, false, ctx);
      return undefined;
    }
  }
  return undefined;
}

export default function (pi: ExtensionAPI) {
  pi.on("session_start", async (_event, ctx) => {
    if (ctx?.hasUI) {
      ctx.ui.notify(
        `[SEGURANÇA] Guarda carregado. Modo: ${process.env.PI_SECURITY_MODE ?? "interactive"}`,
        "info"
      );
    }
  });

  pi.on("tool_call", async (event, ctx) => {
    const config = getConfig(ctx);
    const toolName = event.toolName;
    const input = event.input as Record<string, unknown>;

    if (toolName === "bash") {
      const command = input.command as string;
      if (!command) return undefined;
      return handleBashCommand(command, ctx, config);
    }

    if (toolName === "write" || toolName === "edit") {
      const path = input.path as string;
      if (!path) return undefined;
      return handlePathAccess(toolName, path, ctx, config);
    }

    if (toolName === "read") {
      const path = input.path as string;
      if (!path) return undefined;
      return handlePathAccess(toolName, path, ctx, config);
    }

    // Catch-all: check any tool string/array parameters for sensitive paths
    // Covers codegraph_*, web_fetch, mcp, and other tools not explicitly handled
    const stringValues: string[] = [];
    for (const value of Object.values(input)) {
      if (typeof value === "string") {
        stringValues.push(value);
      } else if (Array.isArray(value)) {
        for (const item of value) {
          if (typeof item === "string") stringValues.push(item);
        }
      }
    }
    for (const str of stringValues) {
      if (str.length === 0) continue;
      for (const entry of SENSITIVE_PATH_PATTERNS) {
        if (entry.pattern.test(str)) {
          await logEvent(toolName, `${entry.reason}: ${str}`, true, ctx);
          if (config.mode === "strict") {
            return { block: true, reason: `[BLOQUEADO] ${entry.reason}: ${str}` };
          }
          if (config.mode === "audit-only" || config.mode === "permissive") {
            return undefined;
          }
          if (!ctx.hasUI) {
            return { block: true, reason: `[BLOQUEADO] ${entry.reason}: ${str} (modo não-interativo)` };
          }
          const choice = await ctx.ui.select(
            `\u26A0\uFE0F Parâmetro sensível em ${toolName} (${entry.severity.toUpperCase()}):\n  ${entry.reason}\n\nValor: ${str}`,
            ["Permitir esta vez", "Bloquear"]
          );
          if (choice === "Bloquear") {
            return { block: true, reason: `[BLOQUEADO PELO USUÁRIO] ${entry.reason}` };
          }
          await logEvent(toolName, `${entry.reason}: ${str} (permitido pelo usuário)`, false, ctx);
          return undefined;
        }
      }
    }

    return undefined;
  });
}
