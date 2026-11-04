// Copyright 2026 Bay. Apache-2.0.
#ifndef CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_H_
#define CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_H_

#include <map>
#include <memory>
#include <optional>
#include <set>
#include <string>
#include <vector>

#include "base/files/file_path.h"
#include "base/functional/callback.h"
#include "base/memory/scoped_refptr.h"
#include "base/no_destructor.h"
#include "base/sequence_checker.h"
#include "base/task/sequenced_task_runner.h"
#include "base/timer/timer.h"
#include "base/values.h"

namespace network {
class SimpleURLLoader;
}

namespace bay {

// Bay's content blocker on the desktop host: packages/adblock's engine, which
// nn_request_filter asks about every request. The same lists, cache, settings
// and answers as NNCoreContentBlocker.mm on macOS (docs/content-blocker.md),
// kept in <user data>/Content Blocker. UI sequence, unless a method says not.
class ContentBlocker {
 public:
  using Done = base::OnceCallback<void(std::optional<std::string> error)>;
  // The app's onContentBlocker event, with its stats.
  using Sink = base::RepeatingCallback<void(base::DictValue stats)>;

  static ContentBlocker& Get();
  ContentBlocker(const ContentBlocker&) = delete;
  ContentBlocker& operator=(const ContentBlocker&) = delete;

  // Reads settings, installs the request filter and builds the engine. Once.
  void Prepare();
  void SetSink(Sink sink);
  // Runs `ready` once settings are in; the methods below need them.
  void WhenLoaded(base::OnceClosure ready);
  bool loaded() const { return loaded_; }

  base::DictValue State();
  void SetEnabled(bool enabled, Done done);
  void SetListEnabled(const std::string& id, bool enabled, Done done);
  bool IsAllowed(const std::string& host);
  void SetAllowed(const std::string& host, bool allowed, Done done);
  void SetPageAllowed(const std::string& host,
                      bool allowed,
                      bool remember,
                      Done done);

  struct Built;

  // Whether the blocker refuses this page itself ($doc, a listed hostname).
  // Any thread.
  static bool BlocksPage(const std::string& url);
  struct Cosmetics {
    std::optional<std::string> css;
    bool generic = false;
    std::optional<base::ListValue> procedural;
  };
  // A frame's cosmetic filters, for its document at `frame_url` in a tab
  // showing `page_url`; nullopt when blocking is off there. Any thread.
  static std::optional<Cosmetics> CosmeticsFor(const std::string& frame_url,
                                               const std::string& page_url);
  // The generic rules that hide these classes and ids. Any thread.
  static std::optional<std::string> GenericStyle(
      const std::string& frame_url,
      const std::string& page_url,
      const std::vector<std::string>& classes,
      const std::vector<std::string>& ids);

 private:
  friend class base::NoDestructor<ContentBlocker>;
  using Rebuilt = base::OnceCallback<void(std::vector<std::string> missing)>;

  ContentBlocker();
  ~ContentBlocker();

  void SettingsRead(std::optional<base::Value> catalogue,
                    std::optional<base::Value> saved);
  bool OnByDefault(const base::DictValue& list) const;
  void SaveSettings();
  void PublishLive();
  void Changed();
  void Emit();
  base::DictValue Stats() const;
  std::vector<std::string> SelectedInOrder() const;
  const base::DictValue* List(const std::string& id) const;
  void Rebuild(bool use_cache, Rebuilt done);
  void Seeded(uint64_t generation,
              std::vector<std::string> ids,
              bool use_cache,
              Rebuilt done,
              std::vector<std::string> absent);
  void BuildAndPublish(uint64_t generation,
                       const std::vector<std::string>& ids,
                       bool use_cache,
                       bool finished,
                       std::vector<std::string> missing,
                       Rebuilt done);
  void Apply(uint64_t generation,
             bool finished,
             std::vector<std::string> missing,
             Rebuilt done,
             std::unique_ptr<Built> built);
  void UpdateLists();
  void Fetch(std::vector<std::string> ids,
             size_t next,
             bool changed,
             base::OnceCallback<void(bool changed)> done);
  void FetchFrom(std::vector<std::string> ids,
                 size_t next,
                 bool changed,
                 size_t url,
                 base::OnceCallback<void(bool changed)> done);
  void Fetched(std::vector<std::string> ids,
               size_t next,
               bool changed,
               size_t url,
               base::OnceCallback<void(bool changed)> done,
               std::unique_ptr<network::SimpleURLLoader> loader,
               std::optional<std::string> body);
  void ScheduleUpdates(base::TimeDelta after);

  base::FilePath directory_;
  base::FilePath resources_;
  scoped_refptr<base::SequencedTaskRunner> work_;
  base::ListValue catalogue_;
  bool loaded_ = false;
  std::vector<base::OnceClosure> waiting_;
  bool enabled_ = true;
  std::vector<std::string> selected_;
  std::vector<std::string> allowed_;
  std::vector<std::string> allowed_pages_;
  std::vector<std::string> session_pages_;
  bool ready_ = false;
  double parse_ms_ = 0;
  std::map<std::string, std::pair<double, double>> counts_;
  uint64_t generation_ = 0;
  std::shared_ptr<void> engine_;
  Sink sink_;
  base::OneShotTimer updates_;
  SEQUENCE_CHECKER(sequence_checker_);
};

}  // namespace bay

#endif  // CHROME_BROWSER_BAY_WEBUI_CONTENT_BLOCKER_H_
