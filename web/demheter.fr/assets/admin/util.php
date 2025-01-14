<?php

ini_set("display_errors", 0);
ini_set("display_startup_errors", 0);
ini_set("log_errors", 1);

// Everything is fatal
set_error_handler(function($type, $message, $filename, $line) {
    throw new ErrorException($message, 0, $type, $filename, $line);
});
set_exception_handler(function($e) {
    fatal(500, '' . $e);
});
register_shutdown_function(function() {
    $error = error_get_last();

    if ($error != null)
        fatal(500, $error["message"]);
});

if (!function_exists('str_starts_with')) {
    function str_starts_with($haystack, $needle) {
        $needle = (string)$needle;
        return $needle !== '' && strncmp($haystack, $needle, strlen($needle)) === 0;
    }
}
if (!function_exists('str_ends_with')) {
    function str_ends_with($haystack, $needle) {
        $needle = (string)$needle;
        return $needle !== '' && substr($haystack, -strlen($needle)) === $needle;
    }
}
if (!function_exists('str_contains')) {
    function str_contains($haystack, $needle) {
        return $needle !== '' && mb_strpos($haystack, $needle) !== false;
    }
}
if (!function_exists("array_is_list")) {
    function array_is_list(array $array): bool {
        $i = 0;
        foreach ($array as $k => $v) {
            if ($k !== $i++)
                return false;
        }
        return true;
    }
}

function assert_method($method) {
    if ($_SERVER["REQUEST_METHOD"] != $method)
        fatal(405, "HTTP method '%s' not allowed", $_SERVER["REQUEST_METHOD"]);

    if ($method != "GET") {
        $header = $_SERVER["HTTP_X_REQUESTED_WITH"] ?? null;
        if ($header != "XMLHTTPRequest")
            fatal(403, "Anti-CSRF header is missing");
    }
}

function assert_admin() {
    $admin = $_SESSION["admin"] ?? false;

    if (!$admin) {
        http_response_code(302);
        header("Location: /admin");
        return;
    }
}

function read_body($max_size) {
    $size = intval($_SERVER["CONTENT_LENGTH"] ?? "-1");

    if ($size < 0)
        fatal(413, "Invalid or missing HTTP body length");
    if ($size > $max_size)
        fatal(413, "HTTP body is too big");

    $data = file_get_contents("php://input", false, null, 0, $max_size);
    return $data;
}

function read_json_body($max_size = 64 * 1024) {
    $data = read_body($max_size);
    $json = json_decode($data, true);

    if ($json === null)
        fatal(422, "Missing or malformed JSON body");
    if (!is_array($json) || array_is_list($json))
        fatal(422, "Missing or malformed JSON body");

    return $json;
}

function fatal($code, $text, ...$args) {
    $text = vsprintf($text, $args);

    if (php_sapi_name() != 'cli') {
        http_response_code($code);
        header("Content-Type: text/plain");
    }

    die($text . "\n");
}


function fetch_all($res) {
    $rows = [];
    while ($row = $res->fetchArray(SQLITE3_ASSOC))
        $rows[] = $row;
    return $rows;
}

?>
