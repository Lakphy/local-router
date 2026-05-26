import Foundation

struct DiffLine: Identifiable {
    enum Kind {
        case unchanged
        case added
        case removed
    }

    let id: Int
    let kind: Kind
    let text: String
    let oldLineNumber: Int?
    let newLineNumber: Int?
}

enum DiffEngine {
    static func computeDiff(old: String, new: String) -> [DiffLine] {
        let oldLines = old.components(separatedBy: .newlines)
        let newLines = new.components(separatedBy: .newlines)

        let lcs = longestCommonSubsequence(oldLines, newLines)

        var result: [DiffLine] = []
        var oldIdx = 0
        var newIdx = 0
        var lcsIdx = 0
        var lineId = 0

        while oldIdx < oldLines.count || newIdx < newLines.count {
            if lcsIdx < lcs.count {
                while oldIdx < oldLines.count && oldLines[oldIdx] != lcs[lcsIdx] {
                    result.append(DiffLine(id: lineId, kind: .removed, text: oldLines[oldIdx], oldLineNumber: oldIdx + 1, newLineNumber: nil))
                    lineId += 1
                    oldIdx += 1
                }
                while newIdx < newLines.count && newLines[newIdx] != lcs[lcsIdx] {
                    result.append(DiffLine(id: lineId, kind: .added, text: newLines[newIdx], oldLineNumber: nil, newLineNumber: newIdx + 1))
                    lineId += 1
                    newIdx += 1
                }
                result.append(DiffLine(id: lineId, kind: .unchanged, text: lcs[lcsIdx], oldLineNumber: oldIdx + 1, newLineNumber: newIdx + 1))
                lineId += 1
                oldIdx += 1
                newIdx += 1
                lcsIdx += 1
            } else {
                while oldIdx < oldLines.count {
                    result.append(DiffLine(id: lineId, kind: .removed, text: oldLines[oldIdx], oldLineNumber: oldIdx + 1, newLineNumber: nil))
                    lineId += 1
                    oldIdx += 1
                }
                while newIdx < newLines.count {
                    result.append(DiffLine(id: lineId, kind: .added, text: newLines[newIdx], oldLineNumber: nil, newLineNumber: newIdx + 1))
                    lineId += 1
                    newIdx += 1
                }
            }
        }

        return result
    }

    private static func longestCommonSubsequence(_ a: [String], _ b: [String]) -> [String] {
        let m = a.count
        let n = b.count
        guard m > 0, n > 0 else { return [] }

        // Use rolling two-row DP to reduce memory from O(m*n) to O(n)
        var prev = Array(repeating: 0, count: n + 1)
        var curr = Array(repeating: 0, count: n + 1)

        for i in 1...m {
            for j in 1...n {
                if a[i - 1] == b[j - 1] {
                    curr[j] = prev[j - 1] + 1
                } else {
                    curr[j] = max(prev[j], curr[j - 1])
                }
            }
            prev = curr
            curr = Array(repeating: 0, count: n + 1)
        }

        // Backtrack using full DP (need directions)
        var dp = Array(repeating: Array(repeating: 0, count: n + 1), count: m + 1)
        for i in 1...m {
            for j in 1...n {
                if a[i - 1] == b[j - 1] {
                    dp[i][j] = dp[i - 1][j - 1] + 1
                } else {
                    dp[i][j] = max(dp[i - 1][j], dp[i][j - 1])
                }
            }
        }

        var result: [String] = []
        result.reserveCapacity(dp[m][n])
        var i = m, j = n
        while i > 0 && j > 0 {
            if a[i - 1] == b[j - 1] {
                result.append(a[i - 1])
                i -= 1
                j -= 1
            } else if dp[i - 1][j] > dp[i][j - 1] {
                i -= 1
            } else {
                j -= 1
            }
        }

        return result.reversed()
    }
}
