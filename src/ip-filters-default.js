// IP 룰 분류 규칙 기본값 (cf-ip-rules-manager/filters.default.json 을 그대로 옮김)
// 화면의 '규칙' 에서 고친 값은 저장소(KV / data/) 의 ip:filters 에 따로 저장되고, '기본값 복원' 은 이 값으로 되돌린다.

export const DEFAULT_FILTERS = {
  "labels": {
    "attack": "위험",
    "gray": "애매",
    "clean": "안전"
  },
  "rules": [
    {
      "id": "d001",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\.env([.~_-]|$|\\?|\\/)",
      "note": ".env 파일 (.env .env.live .env.bak …)"
    },
    {
      "id": "d002",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\/\\.(git|svn|hg|bzr)(\\/|$|\\?)",
      "note": ".git / .svn 등 소스 저장소 폴더"
    },
    {
      "id": "d003",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\/\\.(idea|vscode|docker|dockerenv|aws|ssh|npmrc|htaccess|htpasswd|ds_store|bash_history|config)(\\/|$|\\?|\\.)",
      "note": "숨김 설정 폴더·파일 (.idea .aws .ssh .htaccess .DS_Store …)"
    },
    {
      "id": "d004",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(gcp-sa|service[-_]?account|serviceaccount|firebase[a-z0-9_.-]*\\.json|credentials?\\.(json|ya?ml|txt|csv|xml)|secrets?\\.(json|ya?ml|txt|env)|id_rsa|id_dsa|id_ed25519|\\.pem(\\?|$)|\\.p12(\\?|$)|\\.pfx(\\?|$)|\\.jks(\\?|$)|\\.kdbx(\\?|$)|\\/passwd|\\/shadow)",
      "note": "인증서·키·서비스계정 파일 (gcp-sa, service-account, id_rsa, .pem …)"
    },
    {
      "id": "d005",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(config|configuration|settings|appsettings|composer|package(-lock)?|tsconfig|database|db|env|environment|local)[a-z0-9_.-]*\\.json(\\?|$)",
      "note": "설정 JSON (config/settings/composer/package/database …)"
    },
    {
      "id": "d006",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(^|\\/)(aws|sa|gcp|azure|s3|iam|oauth|jwt|token|api[-_]?keys?|keys?|secrets?|sugar_version)[a-z0-9_.-]*\\.json(\\?|$)",
      "note": "키·토큰 JSON (aws sa gcp jwt token secret …)"
    },
    {
      "id": "d007",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(^|\\/)(runtime-config|config|configuration|env|environment|settings|secrets?|credentials?|keys?|app\\.config|app-?settings|firebase-?config|aws-?config(uration)?)\\.js(\\?|$)",
      "note": "설정 JS (config.js env.js settings.js firebase-config.js …)"
    },
    {
      "id": "d008",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\.(ya?ml|ini|conf|cfg|properties|toml|inc|sql|sqlite|sqlite3|db|mdb|bak|old|orig|save|swp|log)(\\?|$)",
      "note": "설정·DB·백업 확장자 (.yml .ini .sql .mdb .bak .log .inc …)"
    },
    {
      "id": "d009",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(web\\.config|global\\.asa|machine\\.config|applicationhost\\.config|\\.asax|\\.cs(\\?|$)|\\.vb(\\?|$)|\\/bin\\/|\\/app_data\\/|\\/app_code\\/)",
      "note": "IIS 내부 파일 (web.config global.asa /bin/ /App_Data/ …)"
    },
    {
      "id": "d010",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(backup|bak|dump|db|sql|old|www|site|html|public_html|wwwroot|web|data|upload|archive)[a-z0-9_.-]*\\.(zip|tar|tgz|gz|rar|7z|sql)(\\?|$)",
      "note": "백업 압축파일 (backup*.zip dump*.sql www*.tar.gz …)"
    },
    {
      "id": "d011",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\.(php\\d*|phtml|phps|jsp|jspx|do|action|cgi|pl|py|sh|rb)(\\?|$|\\/|[^a-z0-9])",
      "note": "PHP/JSP/CGI 등 이 서버에 없는 플랫폼 확장자"
    },
    {
      "id": "d012",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(wp-login|wp-admin|wp-content|wp-includes|wp-json|xmlrpc|wordpress|\\/wp\\/|\\/wp2\\/|\\/blog\\/wp)",
      "note": "WordPress 경로 (wp-login wp-admin xmlrpc …)"
    },
    {
      "id": "d013",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(phpmyadmin|\\/pma\\/|myadmin|adminer|phpinfo|dbadmin|sqladmin|\\/mysql\\/)",
      "note": "phpMyAdmin 등 DB 관리툴"
    },
    {
      "id": "d014",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(\\/cgi-bin\\/|vendor\\/phpunit|phpunit|eval-stdin|\\/think\\/|thinkphp|laravel|_ignition|telescope|debug\\/default|\\/artisan)",
      "note": "PHP 프레임워크 흔적 (Laravel ThinkPHP phpunit eval-stdin …)"
    },
    {
      "id": "d015",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\/(actuator|console|manager\\/html|jmx-console|web-console|invoker|solr|jenkins|hudson|druid|nacos|zabbix|nagios|geoserver|struts|struts2|axis2|jboss|weblogic|wls-wsat|owa|ecp|autodiscover|exchange|zimbra|remote\\/login|remote\\/fgt_lang|\\+cscoe\\+|dana-na|global-protect|sslvpn|pulse|boaform|hnap1|gponform|setup\\.cgi|tmunblock|goform|webui|api\\/session\\/properties|rest\\/api|api\\/jsonws|jsonrpc|graphql|swagger|v2\\/_catalog|_all_dbs|hazelcast|kibana|elasticsearch|_search|prometheus|metrics|grafana|minio|aspnet_client|servlet|ws_utc|uddiexplorer|ofbiz|cpanel|webmail|roundcube|phpmailer|mailer|node_modules|bower_components|dvr|nvr|onvif|rom-0|login\\.cgi|deviceinfo|shell|cmd)(\\/|$|\\?)",
      "note": "관리콘솔·장비·프레임워크 경로 (actuator solr jenkins owa graphql swagger shell cmd …)"
    },
    {
      "id": "d016",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\/(env|envfile|kubeconfig|environment|configs?|configuration|debug|trace|dump|heapdump|threaddump|server-status|server-info|livewire|administrator|joomla|sample-page|file-manager|aspera|faspex|sugarcrm)(\\/|$|\\?)",
      "note": "Spring/Laravel/Joomla 흔적 (/env /debug livewire administrator …)"
    },
    {
      "id": "d017",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(\\/components\\/com_|\\/modules\\/mod_|\\/media\\/(vendor|system|jui|com_[a-z0-9_]+)\\/|\\/plugins\\/(system|content|editors|editors-xtd)\\/|\\/@fs\\/|^\\/vendor(\\/|$|\\?)|\\/feed\\/?(atom\\/?|rss\\/?)?$|swagger(\\.json|\\/|$|\\?)|openapi\\.(json|ya?ml))",
      "note": "Joomla/Vite/피드/Swagger 흔적 (components/com_ @fs /feed swagger.json …)"
    },
    {
      "id": "d018",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(\\/\\.vite\\/|asset-manifest\\.json|webpack-stats\\.json|\\/(dist|build|static|public|assets)\\/manifest\\.json|[\\/-]probe(s)?(\\/|$|\\?|-|\\.))",
      "note": "빌드 산출물 manifest 프로빙, 404 동작 탐색 봇"
    },
    {
      "id": "d019",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(\\/plus\\/|dedecms|\\/dede\\/|\\/e\\/data\\/|\\/e\\/admin\\/|metinfo|ueditor|kindeditor|fckeditor|ckfinder|layui|uploadify|\\/ucms\\/|\\/apps\\/admin\\/|\\/public\\/ui\\/met\\/|miniprogram|\\/typo3|\\/drupal|\\/sites\\/default\\/files|\\/misc\\/drupal|\\/magento|\\/skin\\/frontend|\\/bitrix\\/|\\/umbraco|\\/sitecore|\\/telerik|\\/desktopmodules|\\/dnn\\/|zb_users|\\/statics\\/|\\/plug\\/oem\\/|\\/alipay\\/|tiny_?mce|jquery\\.filer|\\/public\\/plugins\\/(ueditor|ckeditor)\\/)",
      "note": "다른 CMS 흔적 (DedeCMS MetInfo EmpireCMS UEditor Drupal Magento Bitrix …)"
    },
    {
      "id": "d020",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(\\.\\.\\/|\\.\\.%2f|%2e%2e|\\/etc\\/passwd|\\/proc\\/self|\\/windows\\/win\\.ini|boot\\.ini|cmd\\.exe|powershell|\\/bin\\/sh|\\/bin\\/bash|\\/var\\/www|\\/usr\\/|\\/tmp\\/|\\/dev\\/|c:\\\\|c:%5c|\\/winnt\\/|system32)",
      "note": "경로 탐색·시스템 경로 (../ /etc/passwd cmd.exe /var/www …)"
    },
    {
      "id": "d021",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(<script|%3cscript|javascript:|onerror=|onload=|union.{0,40}select|xp_cmdshell|waitfor.{0,10}delay|sleep\\(|benchmark\\(|information_schema|sysobjects|char\\(|concat\\(|0x[0-9a-f]{8,}|\\$\\{|\\{\\{|%24%7b|jndi:|base64_decode|eval\\(|assert\\(|passthru|shell_exec|system\\(|phpinfo\\(|\\/etc\\/)",
      "note": "인젝션 문자열 (<script union select ${ jndi: eval( …)"
    },
    {
      "id": "d022",
      "cat": "attack",
      "field": "ua",
      "type": "regex",
      "pattern": "(zgrab|masscan|nmap|nikto|sqlmap|nuclei|dirbuster|gobuster|ffuf|wpscan|acunetix|nessus|openvas|netsparker|burp|w3af|arachni|zmeu|morfeus|jorgee|l9explore|l9tcpid|expanse|paloaltonetworks|censys|shodan|internet-measurement|zmap|projectdiscovery|xfa1|crusader|404-probe|hello,?\\s*world)",
      "note": "보안 스캐너·대량 스캔 (zgrab masscan nmap nikto sqlmap nuclei censys shodan …)"
    },
    {
      "id": "d023",
      "cat": "attack",
      "field": "ua",
      "type": "regex",
      "pattern": "(python-requests|python-urllib|aiohttp|httpx\\/|go-http-client|fasthttp|curl\\/|wget\\/|libwww-perl|lwp-trivial|^java\\/|apache-httpclient|httpclient\\/|scrapy|node-fetch|axios\\/|undici|got\\/|^ruby|^perl|^php\\/|guzzle|winhttp|^-$)",
      "note": "스크립트·라이브러리 (python-requests curl wget Go-http-client Java …)"
    },
    {
      "id": "d024",
      "cat": "clean",
      "field": "url",
      "type": "regex",
      "pattern": "\\.(css|js|mjs|map|png|jpe?g|gif|webp|avif|svg|ico|bmp|tiff?|woff2?|ttf|eot|otf|mp4|webm|m4v|mov|mp3|wav|ogg|m4a|pdf|hwp|hwpx|docx?|xlsx?|pptx?|txt)$",
      "note": "정적 파일 확장자 (css js 이미지 폰트 영상 문서 txt)"
    },
    {
      "id": "d025",
      "cat": "clean",
      "field": "url",
      "type": "regex",
      "pattern": "(^|\\/)(favicon\\.ico|apple-touch-icon[a-z0-9-]*\\.png|robots\\.txt|sitemap[a-z0-9_-]*\\.xml|ads\\.txt|humans\\.txt|manifest\\.json|site\\.webmanifest|browserconfig\\.xml|opensearch\\.xml|crossdomain\\.xml|clientaccesspolicy\\.xml)$",
      "note": "브라우저·봇 표준 파일 (favicon apple-touch-icon robots.txt sitemap manifest.json …)"
    },
    {
      "id": "d026",
      "cat": "clean",
      "field": "url",
      "type": "regex",
      "pattern": "^\\/\\.well-known\\/(assetlinks\\.json|apple-app-site-association|security\\.txt|acme-challenge\\/|change-password|gpc\\.json|dnt-policy\\.txt|traffic-advice)",
      "note": ".well-known 표준 파일 (assetlinks apple-app-site-association security.txt acme-challenge …)"
    },
    {
      "id": "d027",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\/\\.(?!well-known(\\/|$|\\?))[a-z0-9_~-]+",
      "note": "숨김 파일·폴더 전체 (/.gitconfig /.ftpconfig /.rt …). .well-known 은 제외"
    },
    {
      "id": "d028",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(^|\\/)(license|licence|readme|changelog|install|upgrade)\\.(txt|md|html?)(\\?|$)",
      "note": "CMS 버전 확인용 파일 (license.txt readme.txt changelog …)"
    },
    {
      "id": "d029",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "(169\\.254\\.169\\.254|\\/latest\\/meta-data|metadata\\.google\\.internal|100\\.100\\.100\\.200)",
      "note": "클라우드 메타데이터 SSRF 시도 (169.254.169.254 …)"
    },
    {
      "id": "d030",
      "cat": "attack",
      "field": "ua",
      "type": "regex",
      "pattern": "^mozilla\\/5\\.0 \\([^)]*\\) chrome\\/[\\d.]+$",
      "note": "가짜 Chrome UA — AppleWebKit/Safari 부분 없음 (favicon-196x196.png 스캐너)"
    },
    {
      "id": "d031",
      "cat": "attack",
      "field": "ua",
      "type": "regex",
      "pattern": "^mozilla\\/5\\.0 applewebkit\\/[\\d.]+ \\(khtml, like gecko\\) chrome\\/[\\d.]+ safari\\/[\\d.]+$",
      "note": "가짜 Chrome UA — OS 정보 괄호 없음"
    },
    {
      "id": "d032",
      "cat": "attack",
      "field": "ua",
      "type": "regex",
      "pattern": "applewebkit\\/[\\d.]+$",
      "note": "중간에 잘린 UA — AppleWebKit/537.36 으로 끝남 (notes 400자 초과로 잘린 경우는 제외됨)"
    },
    {
      "id": "d033",
      "cat": "attack",
      "field": "url",
      "type": "regex",
      "pattern": "\\.aspx?\\/.+\\.(js|css|gif|png|jpe?g|txt|php|xml|json)(\\?|$)",
      "note": ".asp 뒤에 경로를 붙인 path-info 형태로 정적 파일 요청 (/index.asp/libs/tinymce/… 지문 스캔)"
    }
  ]
};
