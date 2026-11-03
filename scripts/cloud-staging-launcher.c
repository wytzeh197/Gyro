#include <mach-o/dyld.h>
#include <limits.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int main(void) {
    char launcher[PATH_MAX], resolved[PATH_MAX], binary[PATH_MAX];
    char data[PATH_MAX], data_env[PATH_MAX + 32], home_env[PATH_MAX + 8];
    uint32_t capacity = sizeof(launcher);
    struct passwd *owner = getpwuid(getuid());
    if (!owner || _NSGetExecutablePath(launcher, &capacity) || !realpath(launcher, resolved))
        return 2;
    char *slash = strrchr(resolved, '/');
    if (!slash) return 2;
    *slash = '\0';
    if (snprintf(binary, sizeof(binary), "%s/gyro-desktop", resolved) >= (int)sizeof(binary))
        return 2;
    if (snprintf(data, sizeof(data), "%s/Library/Application Support/Gyro Cloud Staging", owner->pw_dir) >= (int)sizeof(data))
        return 2;
    umask(077);
    (void)mkdir(data, 0700);
    struct stat info;
    if (lstat(data, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid() || (info.st_mode & 077))
        return 2;
    if (snprintf(data_env, sizeof(data_env), "GYRO_TEST_DATA_DIR=%s", data) >= (int)sizeof(data_env))
        return 2;
    if (snprintf(home_env, sizeof(home_env), "HOME=%s", owner->pw_dir) >= (int)sizeof(home_env))
        return 2;
    char *args[] = {binary, NULL};
    char *environment[] = {
        home_env, data_env, "GYRO_TEST_PERSIST_UI=1",
        "PATH=/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        NULL
    };
    execve(binary, args, environment);
    perror("Gyro Cloud Staging launcher");
    return 2;
}
