#include <mach-o/dyld.h>
#include <errno.h>
#include <fcntl.h>
#include <limits.h>
#include <pwd.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#ifndef GYRO_STAGING_PROJECT
#error "The staging launcher requires a validated Auth project define."
#endif
_Static_assert(sizeof(GYRO_STAGING_PROJECT) == 21, "Staging project must contain 20 lowercase letters.");
static const char staging_project[] = GYRO_STAGING_PROJECT;

static int valid_project(const char *project) {
    if (!project || strlen(project) != 20) return 0;
    for (size_t index = 0; index < 20; index++)
        if (project[index] < 'a' || project[index] > 'z') return 0;
    return 1;
}

static int safe_directory(int fd, int private_directory) {
    struct stat info;
    if (fstat(fd, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid())
        return 0;
    if (private_directory) return (info.st_mode & 0777) == 0700;
    return (info.st_mode & 022) == 0;
}

/* Open each owned directory without following links; never chmod/migrate old profiles. */
static int prepare_data_directory(const char *home, char *data, size_t capacity) {
    if (!home || home[0] != '/' || !valid_project(staging_project)) return 0;
    int fd = open(home, O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
    if (fd < 0) return 0;
    if (!safe_directory(fd, 0)) {
        close(fd);
        return 0;
    }
    const char *parts[] = {"Library", "Application Support", "Gyro Cloud Staging", staging_project};
    for (size_t index = 0; index < sizeof(parts) / sizeof(parts[0]); index++) {
        if (mkdirat(fd, parts[index], 0700) && errno != EEXIST) {
            close(fd);
            return 0;
        }
        int child = openat(fd, parts[index], O_RDONLY | O_DIRECTORY | O_NOFOLLOW);
        close(fd);
        if (child < 0) return 0;
        fd = child;
        if (!safe_directory(fd, index >= 2)) {
            close(fd);
            return 0;
        }
    }
    close(fd);
    int written = snprintf(data, capacity, "%s/Library/Application Support/Gyro Cloud Staging/%s", home, staging_project);
    return written >= 0 && (size_t)written < capacity;
}

int main(void) {
    char launcher[PATH_MAX], resolved[PATH_MAX], binary[PATH_MAX];
    char data[PATH_MAX], data_env[PATH_MAX + 32], home_env[PATH_MAX + 8];
    uint32_t capacity = sizeof(launcher);
    struct passwd *owner = getpwuid(getuid());
    if (!valid_project(staging_project) || !owner || _NSGetExecutablePath(launcher, &capacity) || !realpath(launcher, resolved))
        return 2;
    char *slash = strrchr(resolved, '/');
    if (!slash) return 2;
    *slash = '\0';
    if (snprintf(binary, sizeof(binary), "%s/gyro-desktop", resolved) >= (int)sizeof(binary))
        return 2;
    umask(077);
    if (!prepare_data_directory(owner->pw_dir, data, sizeof(data))) return 2;
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
