import path from 'path';
import Datastore from 'nedb';

import type {FeedItem} from 'feedsub';

import BaseService from './BaseService';
import config from '../../config';
import FeedReader from '../models/FeedReader';
import {getFeedItemsMatchingRules, getTorrentUrlsFromFeedItem} from '../util/feedUtil';

import type {AddFeedOptions, AddRuleOptions, ModifyFeedOptions} from '../../shared/types/api/feed-monitor';
import type {Feed, Item, MatchedTorrents, Rule} from '../../shared/types/Feed';
import type {FeedReaderOptions} from '../models/FeedReader';

class FeedService extends BaseService {
  db = this.loadDatabase();
  feedReaders: Array<FeedReader> = [];
  rules: {
    [feedID: string]: Array<Rule>;
  } = {};

  constructor(...args: ConstructorParameters<typeof BaseService>) {
    super(...args);

    this.onServicesUpdated = () => {
      this.init();
    };
  }

  /**
   * Subscribes to a feed
   *
   * @param {AddFeedOptions} options - An object of options...
   * @return {Promise<Feed>} - Resolves with Feed or rejects with error.
   */
  async addFeed({url, label, interval}: AddFeedOptions): Promise<Feed> {
    if (typeof url !== 'string' || typeof label !== 'string' || typeof interval !== 'number') {
      return Promise.reject();
    }

    if (this.db == null) {
      return Promise.reject();
    }

    const newFeed = await new Promise<Feed>((resolve, reject) => {
      this.db.insert({type: 'feed', url, label, interval}, (err, newDoc) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(newDoc as Feed);
      });
    });

    this.startNewFeed(newFeed);

    return newFeed;
  }

  /**
   * Modifies the options of a feed subscription
   *
   * @param {string} id - Unique ID of the feed
   * @param {ModifyFeedOptions} options - An object of options...
   * @return {Promise<void>} - Rejects with error.
   */
  async modifyFeed(id: string, {url, label, interval}: ModifyFeedOptions): Promise<void> {
    if (url != null && typeof url !== 'string') {
      return Promise.reject();
    }

    if (label != null && typeof label !== 'string') {
      return Promise.reject();
    }

    if (interval != null && typeof interval !== 'number') {
      return Promise.reject();
    }

    const modifiedFeedReader = this.feedReaders.find((feedReader) => feedReader.getOptions().feedID === id);

    if (modifiedFeedReader == null || this.db == null) {
      return Promise.reject();
    }

    // JSON.parse(JSON.stringify()) to remove undefined properties

    modifiedFeedReader.stopReader();
    modifiedFeedReader.modify(JSON.parse(JSON.stringify({feedLabel: label, url, interval})));

    return new Promise<void>((resolve, reject) => {
      this.db.update({_id: id}, {$set: JSON.parse(JSON.stringify({label, url, interval}))}, {}, (err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  async addRule(options: AddRuleOptions): Promise<Rule> {
    const newRule = await new Promise<Rule>((resolve, reject) => {
      this.db.insert({type: 'rule', ...options}, (err, newDoc) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(newDoc as Rule);
      });
    });

    if (this.rules[newRule.feedIDs[0]] == null) {
      this.rules[newRule.feedIDs[0]] = [];
    }

    this.rules[newRule.feedIDs[0]].push(newRule);

    const associatedFeedReader = this.feedReaders.find(
      (feedReader) => feedReader.getOptions().feedID === newRule.feedIDs[0],
    );

    if (associatedFeedReader) {
      this.handleNewItems(associatedFeedReader.getOptions(), associatedFeedReader.getItems());
    }

    return newRule;
  }

  async getAll(): Promise<{feeds: Array<Feed>; rules: Array<Rule>}> {
    if (this.db == null) {
      return Promise.reject();
    }

    return new Promise<{feeds: Array<Feed>; rules: Array<Rule>}>((resolve, reject) => {
      this.db.find({}, (err: Error | null, docs: Array<Feed | Rule>) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(
          docs.reduce(
            (memo: {feeds: Array<Feed>; rules: Array<Rule>}, item) => {
              if (item.type === 'feed') {
                memo.feeds.push(item);
              }

              if (item.type === 'rule') {
                memo.rules.push(item);
              }

              return memo;
            },
            {feeds: [], rules: []},
          ),
        );
      });
    });
  }

  async getFeeds(id?: string): Promise<Array<Feed>> {
    return new Promise<Array<Feed>>((resolve, reject) => {
      this.db.find(id ? {_id: id} : {type: 'feed'}, (err: Error | null, feeds: Array<Feed>) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(feeds);
      });
    });
  }

  async getItems(id: string, search: string): Promise<Array<Item>> {
    const selectedFeedReader = this.feedReaders.find((feedReader) => feedReader.getOptions().feedID === id);

    if (selectedFeedReader == null) {
      return Promise.reject();
    }

    const items = selectedFeedReader.getItems();

    const filteredItems = search
      ? items.filter((item) => {
          if (typeof item.title === 'string') {
            return item.title.toLowerCase().includes(search.toLowerCase());
          }
          return false;
        })
      : items;

    return filteredItems.map((item) => {
      return {
        title: typeof item.title === 'string' ? item.title : 'Unknown',
        urls: getTorrentUrlsFromFeedItem(item),
      };
    });
  }

  async getPreviouslyMatchedUrls(): Promise<Array<string>> {
    return new Promise((resolve, reject) => {
      this.db.find({type: 'matchedTorrents'}, (err: Error, docs: Array<MatchedTorrents>) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(docs.reduce((matchedUrls: Array<string>, doc) => matchedUrls.concat(doc.urls), []));
      });
    });
  }

  async getRules(): Promise<Array<Rule>> {
    return new Promise<Array<Rule>>((resolve, reject) => {
      this.db.find({type: 'rule'}, (err: Error | null, rules: Array<Rule>) => {
        if (err) {
          reject(err);
          return;
        }

        resolve(rules);
      });
    });
  }

  handleNewItems = (feedReaderOptions: FeedReaderOptions, feedItems: Array<FeedItem>): void => {
    this.getPreviouslyMatchedUrls()
      .then((previouslyMatchedUrls) => {
        const {feedID, feedLabel} = feedReaderOptions;
        const applicableRules = this.rules[feedID];
        if (!applicableRules) return;

        const itemsMatchingRules = getFeedItemsMatchingRules(feedItems, applicableRules);
        const itemsToDownload = itemsMatchingRules.filter((item) =>
          item.urls.some((url) => !previouslyMatchedUrls.includes(url)),
        );

        if (itemsToDownload.length === 0) {
          return;
        }

        Promise.all(
          itemsToDownload.map(
            async (item): Promise<Array<string>> => {
              const {urls, destination, start, tags, ruleID} = item;
              await this.services?.clientGatewayService
                ?.addTorrentsByURL({
                  urls,
                  cookies: {},
                  destination,
                  tags,
                  start,
                  isBasePath: false,
                  isCompleted: false,
                  isSequential: false,
                })
                .then(() => {
                  this.db.update({_id: feedID}, {$inc: {count: 1}}, {upsert: true});
                  this.db.update({_id: ruleID}, {$inc: {count: 1}}, {upsert: true});
                })
                .catch(console.error);

              return urls;
            },
          ),
        ).then((ArrayOfURLArrays) => {
          const addedURLs = ArrayOfURLArrays.reduce(
            (URLArray: Array<string>, urls: Array<string>) => URLArray.concat(urls),
            [],
          );

          this.db.update({type: 'matchedTorrents'}, {$push: {urls: {$each: addedURLs}}}, {upsert: true});

          this.services?.notificationService.addNotification(
            itemsToDownload.map((item) => ({
              id: 'notification.feed.torrent.added',
              data: {
                title: item.matchTitle,
                feedLabel,
                ruleLabel: item.ruleLabel,
              },
            })),
          );
          this.services?.torrentService.fetchTorrentList();
        });
      })
      .catch(console.error);
  };

  private init() {
    this.db.find({}, (err: Error, docs: Array<Feed | Rule>) => {
      if (err) {
        return;
      }

      // Create two arrays, one for feeds and one for rules.
      const feedsSummary: {
        feeds: Array<Feed>;
        rules: Array<Rule>;
      } = docs.reduce(
        (accumulator: {feeds: Array<Feed>; rules: Array<Rule>}, doc) => {
          if (doc.type === 'feed') {
            accumulator.feeds.push(doc);
          }

          if (doc.type === 'rule') {
            accumulator.rules.push(doc);
          }

          return accumulator;
        },
        {feeds: [], rules: []},
      );

      // Add all download rules to the local state.
      feedsSummary.rules.forEach((rule) => {
        const feedID = rule?.feedIDs?.[0];

        // Migration
        if (feedID == null) {
          this.removeItem(rule._id).then(() => {
            const oldFeedID = ((rule as unknown) as {feedID: string})?.feedID;
            if (oldFeedID != null) {
              this.addRule({
                destination: rule.destination,
                tags: rule.tags,
                label: rule.label,
                feedIDs: [oldFeedID],
                field: rule.field,
                match: rule.match,
                exclude: rule.exclude,
                startOnLoad: rule.startOnLoad,
                isBasePath: rule.isBasePath,
              });
            }
          });
          return;
        }

        if (this.rules[feedID] == null) {
          this.rules[feedID] = [];
        }

        this.rules[feedID].push(rule);
      });

      // Initiate all feeds.
      feedsSummary.feeds.forEach((feed) => {
        this.startNewFeed(feed);
      });
    });
  }

  private loadDatabase(): Datastore {
    if (this.db != null) {
      return this.db;
    }

    const db = new Datastore({
      autoload: true,
      filename: path.join(config.dbPath, this.user._id, 'settings', 'feeds.db'),
    });

    return db;
  }

  async removeItem(id: string): Promise<void> {
    let feedReaderToRemoveIndex = -1;
    const feedReaderToRemove = this.feedReaders.find((feedReader, index) => {
      if (feedReader.getOptions().feedID === id) {
        feedReaderToRemoveIndex = index;
        return true;
      }

      return false;
    });

    if (feedReaderToRemove != null) {
      feedReaderToRemove.stopReader();
      this.feedReaders.splice(feedReaderToRemoveIndex, 1);
    }

    return new Promise((resolve, reject) => {
      this.db.remove({_id: id}, {}, (err) => {
        if (err) {
          reject(err);
          return;
        }

        resolve();
      });
    });
  }

  private startNewFeed(feed: Feed) {
    const {_id: feedID, label: feedLabel, url, interval} = feed;

    if (typeof feedID !== 'string' || typeof url !== 'string') {
      return false;
    }

    if (typeof interval !== 'number') {
      return false;
    }

    this.feedReaders.push(
      new FeedReader({
        feedID,
        feedLabel,
        url,
        interval,
        maxHistory: 100,
        onNewItems: this.handleNewItems,
      }),
    );

    return true;
  }
}

export default FeedService;
